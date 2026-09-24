//go:build !windows

package collector

import "time"

// RDPSession represents a remote desktop session (Windows only).
type RDPSession struct {
	Username        string     `json:"username"`
	Domain          string     `json:"domain"`
	SourceIP        string     `json:"source_ip"`
	SessionID       int        `json:"session_id"`
	LogonTime       time.Time  `json:"logon_time"`
	LogoffTime      *time.Time `json:"logoff_time,omitempty"`
	DurationSeconds *int       `json:"duration_seconds,omitempty"`
	LogoffType      string     `json:"logoff_type"`
}

// CollectRDPSessions is a no-op on non-Windows platforms.
func CollectRDPSessions(hoursBack int) []RDPSession { return nil }
