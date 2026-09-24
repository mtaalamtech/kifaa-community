//go:build windows

package collector

import (
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RDPSession represents a single remote desktop session.
type RDPSession struct {
	Username        string     `json:"username"`
	Domain          string     `json:"domain"`
	SourceIP        string     `json:"source_ip"`
	SessionID       int        `json:"session_id"`
	LogonTime       time.Time  `json:"logon_time"`
	LogoffTime      *time.Time `json:"logoff_time,omitempty"`
	DurationSeconds *int       `json:"duration_seconds,omitempty"`
	LogoffType      string     `json:"logoff_type"` // "logoff", "disconnect", "unknown"
}

type psRDPSession struct {
	Username   string `json:"username"`
	Domain     string `json:"domain"`
	SourceIP   string `json:"source_ip"`
	SessionID  int    `json:"session_id"`
	LogonTime  string `json:"logon_time"`
	LogoffTime string `json:"logoff_time"`
	LogoffType string `json:"logoff_type"`
}

// collectActiveViaqWinsta uses `query session` to get currently active RDP sessions.
// This works on all Windows versions even when the event log is empty/disabled.
func collectActiveViaqWinsta() []RDPSession {
	out, err := exec.Command("query", "session").Output()
	if err != nil {
		// try qwinsta as alias
		out, err = exec.Command("qwinsta").Output()
		if err != nil {
			log.Printf("query session error: %v", err)
			return nil
		}
	}

	// Parse qwinsta output lines:
	// SESSIONNAME  USERNAME  ID  STATE  TYPE  DEVICE
	// rdp-tcp#2    john       2  Active rdpwd
	var sessions []RDPSession
	lines := strings.Split(string(out), "\n")
	spaceRe := regexp.MustCompile(`\s+`)
	for _, line := range lines[1:] { // skip header
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		// Remove leading '>' (current session marker)
		line = strings.TrimLeft(line, ">")
		parts := spaceRe.Split(strings.TrimSpace(line), -1)
		if len(parts) < 4 {
			continue
		}

		// Columns vary: if session has a username the layout is:
		// sessionName  username  id  state ...
		// If no username (e.g. services):
		// sessionName  id  state ...
		// We detect by checking if parts[2] is numeric (= id when no username)
		var sessionName, username string
		var sessionID int

		if _, err := strconv.Atoi(parts[1]); err == nil {
			// No username column
			sessionName = parts[0]
			username = ""
			sessionID, _ = strconv.Atoi(parts[1])
		} else {
			sessionName = parts[0]
			username = parts[1]
			sessionID, _ = strconv.Atoi(parts[2])
		}

		if username == "" || strings.EqualFold(username, "none") {
			continue
		}

		// Only include Active or Disc (disconnected but still alive) RDP sessions
		// State is typically at index 3 (with username) or 2 (without)
		stateIdx := 3
		if _, err := strconv.Atoi(parts[1]); err == nil {
			stateIdx = 2
		}
		if stateIdx >= len(parts) {
			continue
		}
		state := strings.ToLower(parts[stateIdx])
		if state != "active" && state != "disc" {
			continue
		}

		// Only count RDP sessions (not console/services)
		isRDP := strings.HasPrefix(strings.ToLower(sessionName), "rdp-tcp") ||
			strings.HasPrefix(strings.ToLower(sessionName), "rdp-np")
		if !isRDP {
			continue
		}

		// Try to get the logon time for this session via WMI
		logonTime := getSessionLogonTime(sessionID)
		if logonTime.IsZero() {
			logonTime = time.Now().UTC()
		}

		logoffType := "unknown"
		if state == "disc" {
			logoffType = "disconnect"
		}

		sessions = append(sessions, RDPSession{
			Username:   username,
			Domain:     "",
			SourceIP:   "",
			SessionID:  sessionID,
			LogonTime:  logonTime,
			LogoffType: logoffType,
		})
	}
	return sessions
}

// getSessionLogonTime tries to get the logon time for a Windows session ID via WMI.
func getSessionLogonTime(sessionID int) time.Time {
	ps := fmt.Sprintf(`
$s = Get-WmiObject -Class Win32_LogonSession | Where-Object { $_.LogonType -in @(10,3) } | Select-Object -First 20
if ($s) {
    $s | ForEach-Object {
        try {
            $users = Get-WmiObject -Class Win32_LoggedOnUser | Where-Object { $_.Dependent -like "*LogonId=%d*" }
            if ($users) { $_.ConvertToDateTime($_.StartTime).ToUniversalTime().ToString('o'); exit }
        } catch {}
    }
}
Write-Output ''
`, sessionID)
	out, err := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps).Output()
	if err != nil {
		return time.Time{}
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return t
}

// CollectRDPSessions reads the TerminalServices-LocalSessionManager event log
// for RDP session start/end events over the past hoursBack hours.
// Falls back to `query session` for active sessions if event log is empty.
// Event IDs: 21=logon, 23=logoff, 24=disconnect, 25=reconnect.
func CollectRDPSessions(hoursBack int) []RDPSession {
	if hoursBack <= 0 {
		hoursBack = 168
	}

	ps := fmt.Sprintf(`
$ErrorActionPreference = 'SilentlyContinue'
$hours = %d
$start = (Get-Date).AddHours(-$hours)
$log   = 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'

# Ensure the log is enabled
try {
    $l = Get-WinEvent -ListLog $log -ErrorAction SilentlyContinue
    if ($l -and -not $l.IsEnabled) {
        $l.IsEnabled = $true
        $l.SaveChanges()
    }
} catch {}

try {
    $evts = Get-WinEvent -FilterHashtable @{LogName=$log; Id=@(21,23,24,25); StartTime=$start} -ErrorAction SilentlyContinue
} catch {
    $evts = $null
}

if (-not $evts) { Write-Output '[]'; exit 0 }

# Build lookup: session_id -> list of events, sorted by time
$bySession = @{}
foreach ($e in $evts) {
    $xml  = [xml]$e.ToXml()
    $data = $xml.Event.UserData.EventXML
    $sid  = [int]($data.SessionID)
    if (-not $bySession.ContainsKey($sid)) {
        $bySession[$sid] = [System.Collections.Generic.List[object]]::new()
    }
    $bySession[$sid].Add([PSCustomObject]@{
        Id        = [int]$e.Id
        Time      = $e.TimeCreated
        User      = [string]($data.User -replace '.*\\', '')
        Domain    = if ($data.User -match '^(.+)\\') { $Matches[1] } else { '' }
        Address   = [string]$data.Address
        SessionID = $sid
    })
}

$out = [System.Collections.Generic.List[object]]::new()

foreach ($sid in $bySession.Keys) {
    $events = $bySession[$sid] | Sort-Object Time
    $logons = $events | Where-Object { $_.Id -in @(21, 25) }
    foreach ($logon in $logons) {
        # Find next logoff or disconnect for this session after this logon
        $end = $events | Where-Object { $_.Id -in @(23, 24) -and $_.Time -gt $logon.Time } | Select-Object -First 1
        $logoffType = 'unknown'
        $logoffTime = ''
        if ($end) {
            $logoffTime = $end.Time.ToUniversalTime().ToString('o')
            $logoffType = if ($end.Id -eq 23) { 'logoff' } else { 'disconnect' }
        }
        $user = $logon.User
        if (-not $user -or $user -eq '-' -or $user -eq '') { continue }
        $out.Add([PSCustomObject]@{
            username    = $user
            domain      = $logon.Domain
            source_ip   = if ($logon.Address -and $logon.Address -ne 'LOCAL') { $logon.Address } else { '' }
            session_id  = $sid
            logon_time  = $logon.Time.ToUniversalTime().ToString('o')
            logoff_time = $logoffTime
            logoff_type = $logoffType
        })
    }
}

if ($out.Count -eq 0) { Write-Output '[]' } else { $out | ConvertTo-Json -Depth 2 -Compress }
`, hoursBack)

	out, err := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps).Output()
	if err != nil {
		log.Printf("RDP sessions PowerShell error: %v", err)
	}

	var sessions []RDPSession

	raw := strings.TrimSpace(string(out))
	if raw != "" && raw != "null" && raw != "[]" {
		if !strings.HasPrefix(raw, "[") {
			raw = "[" + raw + "]"
		}
		var psRows []psRDPSession
		if err := json.Unmarshal([]byte(raw), &psRows); err != nil {
			log.Printf("RDP sessions JSON parse error: %v — raw: %.200s", err, raw)
		} else {
			for _, r := range psRows {
				logon, err := time.Parse(time.RFC3339Nano, r.LogonTime)
				if err != nil {
					continue
				}
				s := RDPSession{
					Username:   r.Username,
					Domain:     r.Domain,
					SourceIP:   r.SourceIP,
					SessionID:  r.SessionID,
					LogonTime:  logon,
					LogoffType: r.LogoffType,
				}
				if r.LogoffTime != "" {
					if logoff, err := time.Parse(time.RFC3339Nano, r.LogoffTime); err == nil {
						s.LogoffTime = &logoff
						dur := int(logoff.Sub(logon).Seconds())
						if dur < 0 {
							dur = 0
						}
						s.DurationSeconds = &dur
					}
				}
				sessions = append(sessions, s)
			}
		}
	}

	// Supplement with currently active sessions from `query session`
	// This catches users who connected before the event log window or when log is disabled
	active := collectActiveViaqWinsta()
	if len(active) > 0 {
		// Merge: only add active sessions not already in event log results
		existing := make(map[int]bool)
		for _, s := range sessions {
			if s.LogoffTime == nil {
				existing[s.SessionID] = true
			}
		}
		for _, a := range active {
			if !existing[a.SessionID] {
				sessions = append(sessions, a)
			}
		}
	}

	return sessions
}
