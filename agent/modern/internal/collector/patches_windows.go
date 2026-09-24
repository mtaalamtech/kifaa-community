//go:build windows

package collector

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// windowsUpdate is the JSON shape returned by our PowerShell query.
type windowsUpdate struct {
	Title    string `json:"Title"`
	Severity string `json:"Severity"`
	KBs      string `json:"KBs"`
}

// CollectPendingUpdates queries Windows Update via PowerShell and returns
// a slice of PatchInfo. It works on Windows Vista/7/8/10/11/Server 2008+.
func CollectPendingUpdates() ([]PatchInfo, error) {
	ps := `
$ErrorActionPreference = 'SilentlyContinue'
try {
    $session  = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $result   = $searcher.Search("IsInstalled=0 and Type='Software'")
    $out = @()
    foreach ($u in $result.Updates) {
        $sev = if ($u.MsrcSeverity) { $u.MsrcSeverity } else { "Unknown" }
        $kbs = ($u.KBArticleIDs -join ",")
        $out += [PSCustomObject]@{ Title=$u.Title; Severity=$sev; KBs=$kbs }
    }
    if ($out.Count -eq 0) { Write-Output "[]" } else { $out | ConvertTo-Json -Compress }
} catch {
    Write-Output "[]"
}
`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("powershell patch query: %w", err)
	}

	raw := strings.TrimSpace(string(out))
	if raw == "" || raw == "[]" {
		return []PatchInfo{}, nil
	}

	// PowerShell returns a single object (not array) when there is only one result
	var updates []windowsUpdate
	if strings.HasPrefix(raw, "[") {
		if err := json.Unmarshal([]byte(raw), &updates); err != nil {
			return nil, fmt.Errorf("parse updates array: %w", err)
		}
	} else {
		var single windowsUpdate
		if err := json.Unmarshal([]byte(raw), &single); err != nil {
			return nil, fmt.Errorf("parse single update: %w", err)
		}
		updates = []windowsUpdate{single}
	}

	patches := make([]PatchInfo, 0, len(updates))
	for _, u := range updates {
		sev := strings.ToLower(u.Severity)
		cat := "upgrade"
		if sev == "critical" || sev == "important" || sev == "moderate" {
			cat = "security"
		}
		// Use the full title as the display name so it matches what Windows Update shows.
		// Put the KB number in AvailableVersion so it can be passed to the apply command.
		kbNumber := ""
		if u.KBs != "" {
			kbNumber = "KB" + strings.SplitN(u.KBs, ",", 2)[0]
		}
		patches = append(patches, PatchInfo{
			PackageName:      u.Title,
			CurrentVersion:   kbNumber,
			AvailableVersion: u.Severity,
			Category:         cat,
			Description:      u.Title,
		})
	}
	return patches, nil
}

// CheckRebootPending returns true if Windows is waiting for a reboot to complete
// pending update installation.
func CheckRebootPending() bool {
	ps := `
try {
    $sysInfo = New-Object -ComObject Microsoft.Update.SystemInfo
    if ($sysInfo.RebootRequired) { Write-Output "true"; exit }
} catch {}
$key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"
if (Test-Path $key) { Write-Output "true" } else { Write-Output "false" }
`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps)
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "true"
}
