//go:build windows && !noad

package collector

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"
)

// psEvent mirrors the JSON structure returned by our PowerShell script.
type psEvent struct {
	EventID         int    `json:"event_id"`
	EventTimeStr    string `json:"event_time"`
	TargetUser      string `json:"target_user"`
	TargetDomain    string `json:"target_domain"`
	CallingComputer string `json:"calling_computer"`
	CallingIP       string `json:"calling_ip"`
	SubjectUser     string `json:"subject_user"`
	Description     string `json:"description"`
}

// ReadADEvents fetches Windows Security Event Log entries using PowerShell.
// For lockout events (4740), it correlates with failed-logon events (4625) to
// capture the source IP and workstation that triggered the lockout.
func ReadADEvents(hours int) []ADEvent {
	if hours <= 0 {
		hours = 48
	}
	dcName, _ := os.Hostname()

	ps := fmt.Sprintf(`
$hours = %d
$start = (Get-Date).AddHours(-$hours)
$ids   = @(4740,4767,4722,4725,4720,4726,4724,4728,4732,4756,4625)
$raw   = Get-WinEvent -FilterHashtable @{LogName='Security';Id=$ids;StartTime=$start} -ErrorAction SilentlyContinue

# Build a lookup of recent 4625 (failed logon) events keyed by username for IP correlation
$failedLogons = @{}
if ($raw) {
    $raw | Where-Object { $_.Id -eq 4625 } | ForEach-Object {
        $p = $_.Properties
        if ($p.Count -gt 5) {
            $u = [string]$p[5].Value
            if ($u -and $u -ne '-' -and $u -ne '') {
                if (-not $failedLogons.ContainsKey($u)) {
                    $failedLogons[$u] = [System.Collections.Generic.List[object]]::new()
                }
                $failedLogons[$u].Add([PSCustomObject]@{
                    Time          = $_.TimeCreated
                    IpAddress     = if ($p.Count -gt 19) { [string]$p[19].Value } else { '' }
                    WorkStation   = if ($p.Count -gt 13) { [string]$p[13].Value } else { '' }
                })
            }
        }
    }
}

$out = $raw | ForEach-Object {
    $p = $_.Properties
    $eId = [int]$_.Id
    $tUser   = ''
    $tDomain = ''
    $callerComputer = ''
    $callerIP = ''
    $subjectUser = ''

    if ($eId -eq 4740) {
        if ($p.Count -gt 4)  { $tUser          = [string]$p[4].Value }
        if ($p.Count -gt 5)  { $tDomain        = [string]$p[5].Value }
        if ($p.Count -gt 7)  { $callerComputer = [string]$p[7].Value }
        if ($p.Count -gt 1)  { $subjectUser    = [string]$p[1].Value }
        # Correlate: find the most recent 4625 for same user within 10 minutes before this lockout
        if ($tUser -and $failedLogons.ContainsKey($tUser)) {
            $lockTime = $_.TimeCreated
            $match = $failedLogons[$tUser] | Where-Object {
                $diff = ($lockTime - $_.Time).TotalMinutes
                $diff -ge 0 -and $diff -le 10
            } | Sort-Object Time -Descending | Select-Object -First 1
            if ($match) {
                if ($match.IpAddress -and $match.IpAddress -ne '-' -and $match.IpAddress -ne '::1' -and $match.IpAddress -ne '') {
                    $callerIP = $match.IpAddress
                }
                if (-not $callerComputer -or $callerComputer -eq '-') {
                    if ($match.WorkStation -and $match.WorkStation -ne '-' -and $match.WorkStation -ne '') {
                        $callerComputer = $match.WorkStation
                    }
                }
            }
        }
    } elseif ($eId -eq 4625) {
        if ($p.Count -gt 5)  { $tUser          = [string]$p[5].Value }
        if ($p.Count -gt 6)  { $tDomain        = [string]$p[6].Value }
        if ($p.Count -gt 13) { $callerComputer = [string]$p[13].Value }
        if ($p.Count -gt 19) { $callerIP       = [string]$p[19].Value }
        if ($p.Count -gt 1)  { $subjectUser    = [string]$p[1].Value }
    } elseif ($eId -in @(4720,4722,4725,4726,4767,4724)) {
        if ($p.Count -gt 0)  { $tUser      = [string]$p[0].Value }
        if ($p.Count -gt 1)  { $tDomain    = [string]$p[1].Value }
        if ($p.Count -gt 5)  { $subjectUser = [string]$p[5].Value }
    } elseif ($eId -in @(4728,4732,4756)) {
        if ($p.Count -gt 0)  { $tUser      = [string]$p[0].Value }
        if ($p.Count -gt 6)  { $subjectUser = [string]$p[6].Value }
    }

    # Skip if no meaningful user (avoids noise)
    if (-not $tUser -or $tUser -eq '-' -or $tUser -eq '') { return }

    [PSCustomObject]@{
        event_id         = $eId
        event_time       = $_.TimeCreated.ToUniversalTime().ToString('o')
        target_user      = $tUser
        target_domain    = $tDomain
        calling_computer = if ($callerComputer -and $callerComputer -ne '-') { $callerComputer } else { '' }
        calling_ip       = if ($callerIP -and $callerIP -ne '-' -and $callerIP -ne '::1') { $callerIP } else { '' }
        subject_user     = $subjectUser
        description      = ($_.Message -replace '\r?\n',' ')
    }
}
if (-not $out) { '[]' } else { $out | ConvertTo-Json -Depth 2 -Compress }
`, hours)

	out, err := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-Command", ps).Output()
	if err != nil {
		log.Printf("AD events PowerShell error: %v", err)
		return nil
	}

	raw := strings.TrimSpace(string(out))
	if raw == "" || raw == "null" {
		return nil
	}

	// PowerShell returns a single object (not array) when there's only one event
	if !strings.HasPrefix(raw, "[") {
		raw = "[" + raw + "]"
	}

	var psEvents []psEvent
	if err := json.Unmarshal([]byte(raw), &psEvents); err != nil {
		log.Printf("AD events JSON parse error: %v — raw: %.200s", err, raw)
		return nil
	}

	var events []ADEvent
	for _, pe := range psEvents {
		t, err := time.Parse(time.RFC3339Nano, pe.EventTimeStr)
		if err != nil {
			continue
		}

		callingIP := pe.CallingIP
		// If no IP from event, try DNS resolution of computer name
		if callingIP == "" && pe.CallingComputer != "" && pe.CallingComputer != "-" {
			if ips, err := net.LookupHost(pe.CallingComputer); err == nil && len(ips) > 0 {
				callingIP = ips[0]
			}
		}

		events = append(events, ADEvent{
			EventID:         pe.EventID,
			EventTime:       t,
			TargetUser:      pe.TargetUser,
			TargetDomain:    pe.TargetDomain,
			CallingComputer: pe.CallingComputer,
			CallingIP:       callingIP,
			DCName:          dcName,
			SubjectUser:     pe.SubjectUser,
			Description:     truncate(pe.Description, 500),
		})
	}
	return events
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
