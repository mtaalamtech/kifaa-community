//go:build !windows

package collector

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// ApplyPatches installs the given packages using the detected package manager.
//
// Strategy:
//  1. Attempt a single batch install with "skip missing" flags.
//  2. Exit 0  → success.
//  3. Exit 100 → apt couldn't fetch some archives.
//     a. If output contains "No route to host" or "connection refused" for the
//        primary Ubuntu mirror → try the global archive.ubuntu.com CDN fallback.
//     b. If the fallback also fails, or no packages were installed at all
//        (0 upgraded, 0 newly installed) → return a clear network-failure error.
//     c. Otherwise (some packages installed, some skipped) → partial success.
//  4. Any other exit code → fall back to per-package installs to isolate
//     incompatible packages without blocking the whole job.
func ApplyPatches(packages []string) (string, error) {
	pm := DetectPackageManager()
	if pm == "" {
		return "", fmt.Errorf("no supported package manager found on this system")
	}

	output, runErr := runBatch(pm, packages)
	if runErr == nil {
		return output, nil
	}

	exitErr, isExit := runErr.(*exec.ExitError)

	if isExit && exitErr.ExitCode() == 100 {
		return handleAptExit100(pm, packages, output)
	}

	// Non-100 exit (dependency conflict, etc.) → try individually.
	if pm == "apt" || pm == "dnf" || pm == "yum" {
		return runIndividual(pm, packages, output)
	}

	return output, fmt.Errorf("%s install failed: %w", pm, runErr)
}

// handleAptExit100 decides whether to retry with a fallback mirror, report
// a network failure, or treat the result as a partial success.
func handleAptExit100(pm string, packages []string, output string) (string, error) {
	lower := strings.ToLower(output)

	// --- Complete routing failure (No route to host / connection refused) ---
	// This means the machine cannot reach the repos at all; a fallback mirror
	// on the same internet path will fail too — but we try the global CDN in
	// case only the regional mirror is blocked.
	noRoute := strings.Contains(lower, "no route to host") ||
		strings.Contains(lower, "connect (113")

	if noRoute {
		// Extract which mirrors are failing so the user gets a clear message.
		failedHosts := extractFailedHosts(output)

		// Only attempt CDN fallback for apt on Ubuntu; skip for dnf/yum.
		if pm == "apt" && isRegionalMirrorFailure(failedHosts) {
			fallbackOut, fallbackErr := tryFallbackMirror(packages, output)
			if fallbackErr == nil {
				return fallbackOut + "\n[INFO] Fallback mirror (archive.ubuntu.com) succeeded.", nil
			}
			// Fallback also failed — check if anything got installed.
			if nothingInstalled(fallbackOut) {
				hosts := strings.Join(failedHosts, ", ")
				return fallbackOut, fmt.Errorf(
					"network connectivity failure: cannot reach %s (No route to host). "+
						"Check firewall/routing on this machine.", hosts)
			}
			// Some packages from the fallback mirror succeeded.
			return fallbackOut + "\n[WARN] Some packages could not be fetched even via fallback mirror.", nil
		}

		// All repos unreachable — full connectivity failure.
		if nothingInstalled(output) {
			hosts := strings.Join(failedHosts, ", ")
			if len(hosts) == 0 {
				hosts = "package repositories"
			}
			return output, fmt.Errorf(
				"network connectivity failure: cannot reach %s (No route to host). "+
					"Check firewall/routing on this machine.", hosts)
		}
	}

	// --- Partial failure (some mirrors down, some packages fetched) ---
	if nothingInstalled(output) {
		// Everything failed but not a routing issue (e.g. 404, timeout).
		return output, fmt.Errorf(
			"no packages were installed — all repositories returned errors. " +
				"Run apt-get update and check your sources.list.")
	}

	return output + "\n[WARN] Some packages could not be fetched (mirror issue). " +
		"Packages that were reachable have been installed.", nil
}

// tryFallbackMirror re-runs apt-get using archive.ubuntu.com (global CDN)
// instead of regional mirrors, without permanently modifying /etc/apt/sources.list.
func tryFallbackMirror(packages []string, originalOutput string) (string, error) {
	// Read the current sources.list
	existing, err := os.ReadFile("/etc/apt/sources.list")
	if err != nil {
		return originalOutput, fmt.Errorf("cannot read /etc/apt/sources.list: %w", err)
	}

	// Replace country-code mirrors (e.g. ke.archive.ubuntu.com, za.archive.ubuntu.com)
	// with the global CDN (archive.ubuntu.com).
	re := regexp.MustCompile(`\b[a-z]{2}\.archive\.ubuntu\.com\b`)
	modified := re.ReplaceAllString(string(existing), "archive.ubuntu.com")

	// Write temp sources.list
	tmpFile, err := os.CreateTemp("", "kifaa-sources-*.list")
	if err != nil {
		return originalOutput, fmt.Errorf("cannot create temp sources: %w", err)
	}
	defer os.Remove(tmpFile.Name())
	if _, err = tmpFile.WriteString(modified); err != nil {
		tmpFile.Close()
		return originalOutput, err
	}
	tmpFile.Close()

	// Run apt-get update against the fallback sources only, then install.
	// Use Dir::Etc::sourcelistparts=/dev/null to skip sources.list.d entries
	// (third-party repos like MongoDB are separately unreachable and handled
	// by --fix-missing).
	aptOpts := []string{
		"-o", "Dir::Etc::sourceslist=" + tmpFile.Name(),
		"-o", "Dir::Etc::sourcelistparts=/dev/null",
		"-o", "Acquire::http::Timeout=20",
		"-o", "Acquire::https::Timeout=20",
	}

	// First update the cache with the fallback mirror.
	updateArgs := append([]string{"apt-get"}, aptOpts...)
	updateArgs = append(updateArgs, "update", "-q")
	updateCmd := exec.Command(updateArgs[0], updateArgs[1:]...)
	updateCmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"DEBIAN_FRONTEND=noninteractive",
	}
	var updateBuf bytes.Buffer
	updateCmd.Stdout = &updateBuf
	updateCmd.Stderr = &updateBuf

	header := "\n[RETRY] Regional mirror unreachable — retrying with archive.ubuntu.com (global CDN):\n"

	// We proceed with install even if update fails (cache may be usable).
	_ = updateCmd.Run()

	installArgs := append([]string{"apt-get", "install", "-y", "--no-install-recommends", "--fix-missing"}, aptOpts...)
	installArgs = append(installArgs, packages...)
	installCmd := exec.Command(installArgs[0], installArgs[1:]...)
	installCmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"DEBIAN_FRONTEND=noninteractive",
	}
	var installBuf bytes.Buffer
	installCmd.Stdout = &installBuf
	installCmd.Stderr = &installBuf
	err = installCmd.Run()

	combined := originalOutput + header + updateBuf.String() + "\n" + installBuf.String()

	// Exit 100 from the fallback is still a (possible) partial success.
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 100 {
		return combined, err // caller will check nothingInstalled
	}
	return combined, err
}

// runBatch performs a single invocation to install all packages at once.
func runBatch(pm string, packages []string) (string, error) {
	args, env := buildInstallCmd(pm, packages)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = env

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// runIndividual installs each package separately, skipping incompatible ones.
func runIndividual(pm string, packages []string, batchOutput string) (string, error) {
	var out strings.Builder
	out.WriteString(batchOutput)
	out.WriteString("\n[INFO] Retrying packages individually to skip incompatible ones...\n\n")

	var succeeded, skipped []string

	for _, pkg := range packages {
		args, env := buildInstallCmd(pm, []string{pkg})
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = env

		var buf bytes.Buffer
		cmd.Stdout = &buf
		cmd.Stderr = &buf
		err := cmd.Run()
		pkgOut := buf.String()

		if err == nil {
			succeeded = append(succeeded, pkg)
			out.WriteString(pkgOut)
			continue
		}

		exitErr, isExit := err.(*exec.ExitError)

		// Network error for this specific package.
		if isExit && exitErr.ExitCode() == 100 {
			lowerPkgOut := strings.ToLower(pkgOut)
			if strings.Contains(lowerPkgOut, "no route to host") ||
				strings.Contains(lowerPkgOut, "connect (113") {
				out.WriteString(fmt.Sprintf("[SKIP] %s: network unreachable — no route to host\n", pkg))
			} else {
				out.WriteString(fmt.Sprintf("[SKIP] %s: mirror unreachable — could not fetch package\n", pkg))
			}
			skipped = append(skipped, pkg)
			continue
		}

		// Dependency or compatibility conflict.
		reason := extractAptDepError(pkgOut)
		if reason == "" {
			reason = strings.TrimSpace(err.Error())
		}
		out.WriteString(fmt.Sprintf("[SKIP] %s: incompatible — %s\n", pkg, reason))
		skipped = append(skipped, pkg)
	}

	out.WriteString(fmt.Sprintf("\n[SUMMARY] Installed: %d  Skipped: %d\n", len(succeeded), len(skipped)))
	if len(skipped) > 0 {
		out.WriteString("Skipped: " + strings.Join(skipped, ", ") + "\n")
	}

	if len(succeeded) == 0 && len(packages) > 0 {
		return out.String(), fmt.Errorf("all %d package(s) failed to install", len(packages))
	}
	return out.String(), nil
}

// buildInstallCmd returns the command args and environment for the given PM.
func buildInstallCmd(pm string, packages []string) (args []string, env []string) {
	env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
	switch pm {
	case "apt":
		env = append(env, "DEBIAN_FRONTEND=noninteractive")
		args = append([]string{"apt-get", "install", "-y", "--no-install-recommends", "--fix-missing"}, packages...)
	case "dnf":
		args = append([]string{"dnf", "upgrade", "-y", "--skip-unavailable"}, packages...)
	case "yum":
		args = append([]string{"yum", "upgrade", "-y"}, packages...)
	case "apk":
		args = append([]string{"apk", "upgrade"}, packages...)
	case "pacman":
		args = append([]string{"pacman", "-S", "--noconfirm"}, packages...)
	case "zypper":
		args = append([]string{"zypper", "--non-interactive", "update"}, packages...)
	}
	return args, env
}

// nothingInstalled returns true when apt output shows 0 packages were upgraded
// or newly installed — meaning the operation had no effect.
func nothingInstalled(output string) bool {
	return strings.Contains(output, "0 upgraded, 0 newly installed") ||
		strings.Contains(output, "0 packages upgraded") ||
		(strings.Contains(output, "upgraded") &&
			strings.Contains(output, "newly installed") &&
			!strings.Contains(output, "1 upgraded") &&
			!strings.Contains(output, "1 newly installed"))
}

// extractFailedHosts parses the apt output for hostnames that failed to connect.
func extractFailedHosts(output string) []string {
	// Match patterns like: "Could not connect to ke.archive.ubuntu.com:80"
	// and "Unable to connect to repo.mongodb.org:https:"
	re := regexp.MustCompile(`(?:Could not connect to|Unable to connect to)\s+([\w.\-]+)`)
	matches := re.FindAllStringSubmatch(output, -1)

	seen := map[string]bool{}
	var hosts []string
	for _, m := range matches {
		if len(m) > 1 && !seen[m[1]] {
			seen[m[1]] = true
			hosts = append(hosts, m[1])
		}
	}
	return hosts
}

// isRegionalMirrorFailure returns true when at least one failed host is a
// country-code Ubuntu mirror (e.g. ke.archive.ubuntu.com).
func isRegionalMirrorFailure(hosts []string) bool {
	re := regexp.MustCompile(`^[a-z]{2}\.archive\.ubuntu\.com$`)
	for _, h := range hosts {
		if re.MatchString(h) {
			return true
		}
	}
	return false
}
