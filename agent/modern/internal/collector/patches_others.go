//go:build !windows

package collector

import (
	"bytes"
	"io"
	"os/exec"
	"strings"
)

// DetectPackageManager returns the canonical PM name for the running system.
func DetectPackageManager() string {
	for _, pm := range []string{"apt-get", "dnf", "yum", "apk", "pacman", "zypper"} {
		if p, err := exec.LookPath(pm); err == nil && p != "" {
			if pm == "apt-get" {
				return "apt"
			}
			return pm
		}
	}
	return ""
}

// CollectPendingUpdates detects the local package manager and returns pending updates.
func CollectPendingUpdates() ([]PatchInfo, error) {
	switch DetectPackageManager() {
	case "apt":
		return scanApt()
	case "dnf":
		return scanDnf()
	case "yum":
		return scanYum()
	case "apk":
		return scanApk()
	case "pacman":
		return scanPacman()
	case "zypper":
		return scanZypper()
	}
	return []PatchInfo{}, nil
}

// runOutput runs a command and returns stdout; stderr is discarded.
func runOutput(name string, args ...string) []byte {
	cmd := exec.Command(name, args...)
	cmd.Stderr = io.Discard
	out, _ := cmd.Output()
	return out
}

// ── APT (Debian / Ubuntu) ───────────────────────────────────────────────────

func scanApt() ([]PatchInfo, error) {
	// Refresh package index silently; ignore errors (may have no network).
	exec.Command("apt-get", "-qq", "update").Run() //nolint:errcheck

	// "apt list --upgradable" format:
	//   pkgname/focal-security 1.2.3 amd64 [upgradable from: 1.2.2]
	out := runOutput("apt", "list", "--upgradable")

	var patches []PatchInfo
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "upgradable from:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pkgName := fields[0]
		repo := ""
		if i := strings.IndexByte(pkgName, '/'); i >= 0 {
			repo = pkgName[i+1:]
			pkgName = pkgName[:i]
		}
		newVer := fields[1]
		oldVer := ""
		if idx := strings.Index(line, "upgradable from: "); idx >= 0 {
			oldVer = strings.TrimRight(strings.TrimSpace(line[idx+17:]), "]")
		}
		cat := "upgrade"
		if strings.Contains(strings.ToLower(repo), "security") {
			cat = "security"
		}
		patches = append(patches, PatchInfo{
			PackageName:      pkgName,
			CurrentVersion:   oldVer,
			AvailableVersion: newVer,
			Category:         cat,
		})
	}

	// Compatibility check: mark held-back packages and detect dependency issues.
	patches = annotateAptCompatibility(patches)
	return patches, nil
}

// annotateAptCompatibility runs compatibility checks on pending apt updates and
// adds a CompatibilityNote to any package that may have issues:
//   - Packages marked as held (pinned via apt-mark hold) will be skipped during install.
//   - Packages with unresolvable dependencies detected via a dry-run simulation.
func annotateAptCompatibility(patches []PatchInfo) []PatchInfo {
	if len(patches) == 0 {
		return patches
	}

	// 1. Detect held packages.
	held := aptHeldPackages()

	// 2. Dry-run simulation to detect dependency conflicts.
	names := make([]string, len(patches))
	for i, p := range patches {
		names[i] = p.PackageName
	}
	conflicted := aptDryRunConflicts(names)

	for i, p := range patches {
		if held[p.PackageName] {
			patches[i].CompatibilityNote = "Package is held/pinned — will be skipped during patching"
		} else if note, bad := conflicted[p.PackageName]; bad {
			patches[i].CompatibilityNote = note
		}
	}
	return patches
}

// aptHeldPackages returns a set of package names that are held back via apt-mark.
func aptHeldPackages() map[string]bool {
	out := runOutput("apt-mark", "showhold")
	held := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if pkg := strings.TrimSpace(line); pkg != "" {
			held[pkg] = true
		}
	}
	return held
}

// aptDryRunConflicts runs "apt-get -s install <packages>" and, if it fails,
// identifies which specific packages have unresolvable dependencies by probing
// them individually. Returns a map of package → conflict description.
func aptDryRunConflicts(packages []string) map[string]string {
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"DEBIAN_FRONTEND=noninteractive",
	}

	// Fast path: batch dry-run succeeds → no conflicts.
	args := append([]string{"apt-get", "-s", "install", "--no-install-recommends"}, packages...)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = env
	cmd.Stderr = io.Discard
	cmd.Stdout = io.Discard
	if cmd.Run() == nil {
		return nil
	}

	// Batch dry-run failed — probe each package individually to pinpoint conflicts.
	conflicts := make(map[string]string)
	for _, pkg := range packages {
		singleArgs := []string{"apt-get", "-s", "install", "--no-install-recommends", pkg}
		singleCmd := exec.Command(singleArgs[0], singleArgs[1:]...)
		singleCmd.Env = env
		var buf bytes.Buffer
		singleCmd.Stdout = &buf
		singleCmd.Stderr = &buf
		if err := singleCmd.Run(); err != nil {
			note := extractAptDepError(buf.String())
			if note == "" {
				note = "Dependency conflict detected during dry-run"
			}
			conflicts[pkg] = note
		}
	}
	return conflicts
}

// extractAptDepError pulls the first "Depends:" or "Conflicts:" line from apt output.
func extractAptDepError(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "Depends:") || strings.Contains(line, "Conflicts:") ||
			strings.HasPrefix(line, "E:") {
			if len(line) > 120 {
				line = line[:120] + "…"
			}
			return line
		}
	}
	return ""
}

// ── DNF (Fedora / RHEL 8+) ──────────────────────────────────────────────────

func scanDnf() ([]PatchInfo, error) {
	// Exit code 100 = updates available — capture output regardless.
	cmd := exec.Command("dnf", "check-update", "--quiet")
	cmd.Stderr = io.Discard
	out, _ := cmd.Output() // ignore error; exit 100 is expected
	return parseDnfYumOutput(string(out)), nil
}

// ── YUM (CentOS / RHEL 7) ────────────────────────────────────────────────────

func scanYum() ([]PatchInfo, error) {
	cmd := exec.Command("yum", "check-update", "--quiet")
	cmd.Stderr = io.Discard
	out, _ := cmd.Output()
	return parseDnfYumOutput(string(out)), nil
}

// parseDnfYumOutput parses the output of "dnf/yum check-update".
// Each line looks like:  package-name.arch  available-version  repo
func parseDnfYumOutput(out string) []PatchInfo {
	var patches []PatchInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Last metadata") || strings.HasPrefix(line, "Obsoleting") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		// fields[0] = "packagename.arch"
		pkgArch := fields[0]
		dot := strings.LastIndexByte(pkgArch, '.')
		pkgName := pkgArch
		if dot >= 0 {
			pkgName = pkgArch[:dot]
		}
		newVer := fields[1]
		repo := ""
		if len(fields) >= 3 {
			repo = fields[2]
		}
		cat := "upgrade"
		if strings.Contains(strings.ToLower(repo), "security") {
			cat = "security"
		}
		patches = append(patches, PatchInfo{
			PackageName:      pkgName,
			AvailableVersion: newVer,
			Category:         cat,
		})
	}
	return patches
}

// ── APK (Alpine Linux) ────────────────────────────────────────────────────────

func scanApk() ([]PatchInfo, error) {
	// "apk upgrade --simulate" prints lines like:
	//   (1/3) Upgrading musl (1.2.3-r4 -> 1.2.4-r0)
	out := runOutput("apk", "upgrade", "--simulate", "--no-progress")

	var patches []PatchInfo
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "Upgrading ") {
			continue
		}
		// e.g. "(1/3) Upgrading musl (1.2.3-r4 -> 1.2.4-r0)"
		inner := line[strings.Index(line, "Upgrading ")+10:]
		space := strings.IndexByte(inner, ' ')
		if space < 0 {
			continue
		}
		pkgName := inner[:space]
		versionPart := strings.Trim(inner[space:], " ()")
		var oldVer, newVer string
		if idx := strings.Index(versionPart, " -> "); idx >= 0 {
			oldVer = versionPart[:idx]
			newVer = versionPart[idx+4:]
		}
		patches = append(patches, PatchInfo{
			PackageName:      pkgName,
			CurrentVersion:   oldVer,
			AvailableVersion: newVer,
			Category:         "upgrade",
		})
	}
	return patches, nil
}

// ── Pacman (Arch Linux) ──────────────────────────────────────────────────────

func scanPacman() ([]PatchInfo, error) {
	// Sync db first
	exec.Command("pacman", "-Sy", "--noconfirm").Run() //nolint:errcheck

	// "pacman -Qu" format:  pkgname old_ver -> new_ver
	out := runOutput("pacman", "-Qu")

	var patches []PatchInfo
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		patches = append(patches, PatchInfo{
			PackageName:      fields[0],
			CurrentVersion:   fields[1],
			AvailableVersion: fields[3],
			Category:         "upgrade",
		})
	}
	return patches, nil
}

// ── Zypper (openSUSE / SLES) ─────────────────────────────────────────────────

func scanZypper() ([]PatchInfo, error) {
	// "zypper list-updates" format (table):
	//   | repo | name | cur-ver | avail-ver | arch
	out := runOutput("zypper", "--non-interactive", "--quiet", "list-updates")

	var patches []PatchInfo
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "|") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 6 {
			continue
		}
		pkgName := strings.TrimSpace(parts[2])
		oldVer := strings.TrimSpace(parts[3])
		newVer := strings.TrimSpace(parts[4])
		if pkgName == "Name" || pkgName == "" {
			continue
		}
		patches = append(patches, PatchInfo{
			PackageName:      pkgName,
			CurrentVersion:   oldVer,
			AvailableVersion: newVer,
			Category:         "upgrade",
		})
	}
	return patches, nil
}

// CheckRebootPending returns true if the Linux system needs a reboot
// (e.g. after kernel or glibc update).
func CheckRebootPending() bool {
	// Debian/Ubuntu: update-manager creates this file
	if _, err := exec.LookPath("ls"); err == nil {
		if _, statErr := exec.Command("test", "-f", "/var/run/reboot-required").Output(); statErr == nil {
			return true
		}
	}
	// Fallback: check the file directly
	f, err := exec.Command("sh", "-c", "test -f /var/run/reboot-required && echo yes").Output()
	if err == nil && strings.TrimSpace(string(f)) == "yes" {
		return true
	}
	return false
}
