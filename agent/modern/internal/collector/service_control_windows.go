//go:build windows

package collector

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type ServiceControlResult struct {
	ServiceName string `json:"service_name"`
	Action      string `json:"action"`
	Success     bool   `json:"success"`
	NewStatus   string `json:"new_status"`
	Message     string `json:"message"`
}

func ControlService(name, action string) ServiceControlResult {
	m, err := mgr.Connect()
	if err != nil {
		return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "connect SCM: " + err.Error()}
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "open service: " + err.Error()}
	}
	defer s.Close()

	switch action {
	case "start":
		if err := s.Start(); err != nil {
			return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "start failed: " + err.Error()}
		}
		st := waitForState(s, svc.Running, 30*time.Second)
		return ServiceControlResult{ServiceName: name, Action: action, Success: st == "running", NewStatus: st, Message: fmt.Sprintf("Service %s", st)}

	case "stop":
		if _, err := s.Control(svc.Stop); err != nil {
			return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "stop failed: " + err.Error()}
		}
		st := waitForState(s, svc.Stopped, 30*time.Second)
		return ServiceControlResult{ServiceName: name, Action: action, Success: st == "stopped", NewStatus: st, Message: fmt.Sprintf("Service %s", st)}

	case "restart":
		// Stop first
		_, _ = s.Control(svc.Stop)
		waitForState(s, svc.Stopped, 30*time.Second)
		// Then start
		if err := s.Start(); err != nil {
			return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "restart/start failed: " + err.Error()}
		}
		st := waitForState(s, svc.Running, 30*time.Second)
		return ServiceControlResult{ServiceName: name, Action: action, Success: st == "running", NewStatus: st, Message: fmt.Sprintf("Service %s after restart", st)}

	default:
		return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "unknown action: " + action}
	}
}

func waitForState(s *mgr.Service, want svc.State, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err == nil && status.State == want {
			return svcControlStateStr(want)
		}
		time.Sleep(500 * time.Millisecond)
	}
	// Return whatever state we're in now
	status, err := s.Query()
	if err != nil {
		return "unknown"
	}
	return svcControlStateStr(status.State)
}

func svcControlStateStr(state svc.State) string { //nolint:unparam
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continuing"
	case svc.PausePending:
		return "pausing"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}
