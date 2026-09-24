//go:build windows

package collector

import (
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// ApplyPatches installs Windows updates / packages.
// KB-prefixed names use WUA COM API; others try winget.
func ApplyPatches(packages []string) (string, error) {
	var out strings.Builder
	var lastErr error

	for _, pkg := range packages {
		var o string
		var err error
		// Extract any KB number from anywhere in the package name/title.
		// Handles: "KB5082123", "...(KB5082123)...", "... - KB2267602 (Version...)"
		if m := kbRe.FindStringSubmatch(pkg); m != nil {
			o, err = installWindowsUpdate("KB" + m[1])
		} else {
			o, err = installWinget(pkg)
		}
		out.WriteString(o)
		if err != nil {
			out.WriteString(fmt.Sprintf("\n[ERROR] %s: %v\n", pkg, err))
			lastErr = err
		}
	}
	return out.String(), lastErr
}

var resultCodeRe = regexp.MustCompile(`\[INFO\] Result code:\s*(\d+)`)
var kbRe = regexp.MustCompile(`(?i)\bKB(\d+)\b`)

func parseResultCode(output string) int {
	m := resultCodeRe.FindStringSubmatch(output)
	if m == nil {
		return -1
	}
	code, _ := strconv.Atoi(m[1])
	return code
}

// stopService stops a Windows service by name, returns false if it wasn't running.
func stopService(name string) bool {
	cmd := exec.Command("sc", "stop", name)
	err := cmd.Run()
	return err == nil
}

// startService starts a Windows service by name.
func startService(name string) {
	exec.Command("sc", "start", name).Run()
}

// sqlServerServices returns the list of SQL Server service names to stop/start
// when a SQL Server update is aborted due to running services.
var sqlServerServices = []string{
	"SQLSERVERAGENT",
	"MSSQLSERVER",
	"MSSQL$SQLEXPRESS",
	"SQLWriter",
}

func stopSQLServerServices() []string {
	var stopped []string
	for _, svc := range sqlServerServices {
		if stopService(svc) {
			stopped = append(stopped, svc)
		}
	}
	return stopped
}

func startServices(services []string) {
	// Start in reverse order (MSSQLSERVER before SQLSERVERAGENT)
	for i := len(services) - 1; i >= 0; i-- {
		startService(services[i])
	}
}

func installWindowsUpdate(kb string) (string, error) {
	kbNum := strings.TrimPrefix(strings.ToUpper(kb), "KB")
	output, err := runWUAInstall(kbNum, kb)
	if err != nil {
		return output, err
	}

	code := parseResultCode(output)
	switch code {
	case 2, 3:
		// Success (2) or SucceededWithErrors (3)
		return output, nil
	case -1:
		// No result code in output — check if the KB was simply not found (already installed / not applicable)
		if strings.Contains(output, "No pending update found") {
			return output, nil
		}
		return output, fmt.Errorf("KB%s install result unclear (could not parse result code) — re-run scan to verify", kbNum)
	case 5:
		// orcAborted — often caused by SQL Server / other services locking files.
		// Stop SQL Server services, retry, then restart them.
		retryOut := "\n[WARN] Update aborted (result code 5) — SQL Server or another service may be locking files.\n"
		retryOut += "[INFO] Stopping SQL Server services and retrying...\n"
		stopped := stopSQLServerServices()
		if len(stopped) > 0 {
			retryOut += fmt.Sprintf("[INFO] Stopped services: %v\n", stopped)
		} else {
			retryOut += "[INFO] No SQL Server services were running to stop.\n"
		}

		retryOutput, retryErr := runWUAInstall(kbNum, kb)
		retryOut += retryOutput

		// Restart services regardless of outcome
		if len(stopped) > 0 {
			startServices(stopped)
			retryOut += fmt.Sprintf("[INFO] Restarted services: %v\n", stopped)
		}

		if retryErr != nil {
			return output + retryOut, retryErr
		}
		retryCode := parseResultCode(retryOut)
		if retryCode == 2 || retryCode == 3 {
			return output + retryOut, nil
		}
		return output + retryOut, fmt.Errorf(
			"KB%s install aborted (code %d) even after stopping SQL Server services. "+
				"Try manually stopping all SQL Server services on this machine, then retry the patch",
			kbNum, retryCode)
	default:
		// Other non-success codes: 4=failed
		return output, fmt.Errorf("KB%s install failed with result code %d", kbNum, code)
	}
}

func runWUAInstall(kbNum, kb string) (string, error) {
	ps := fmt.Sprintf(`
$ErrorActionPreference = 'SilentlyContinue'
try {
    $session  = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $result   = $searcher.Search("IsInstalled=0 and Type='Software'")
    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $result.Updates) {
        if ($u.KBArticleIDs -contains '%s' -or $u.Title -match '%s') {
            $toInstall.Add($u) | Out-Null
        }
    }
    if ($toInstall.Count -eq 0) {
        Write-Output "[INFO] No pending update found matching %s"
    } else {
        Write-Output "[INFO] Downloading $($toInstall.Count) update(s)..."
        $dl = $session.CreateUpdateDownloader()
        $dl.Updates = $toInstall
        $dl.Download() | Out-Null
        Write-Output "[INFO] Installing..."
        $inst = $session.CreateUpdateInstaller()
        $inst.Updates = $toInstall
        $r = $inst.Install()
        Write-Output "[INFO] Result code: $($r.ResultCode)  RebootRequired: $($r.RebootRequired)"
    }
} catch {
    Write-Output "[ERROR] $_"
}
`, kbNum, kb, kb)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

func installWinget(pkg string) (string, error) {
	cmd := exec.Command(
		"winget", "upgrade",
		"--id", pkg,
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
	)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}
