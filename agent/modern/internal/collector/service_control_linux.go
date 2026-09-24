//go:build linux

package collector

import (
	"fmt"
	"os/exec"
	"strings"
)

type ServiceControlResult struct {
	ServiceName string `json:"service_name"`
	Action      string `json:"action"`
	Success     bool   `json:"success"`
	NewStatus   string `json:"new_status"`
	Message     string `json:"message"`
}

func ControlService(name, action string) ServiceControlResult {
	switch action {
	case "start", "stop", "restart":
	default:
		return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "unknown action: " + action}
	}

	cmd := exec.Command("systemctl", action, name)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))

	if err != nil {
		return ServiceControlResult{
			ServiceName: name,
			Action:      action,
			Success:     false,
			Message:     fmt.Sprintf("systemctl %s %s failed: %v — %s", action, name, err, output),
		}
	}

	// Query new status
	newStatus := queryLinuxServiceStatus(name)
	return ServiceControlResult{
		ServiceName: name,
		Action:      action,
		Success:     true,
		NewStatus:   newStatus,
		Message:     fmt.Sprintf("systemctl %s succeeded", action),
	}
}

func queryLinuxServiceStatus(name string) string {
	cmd := exec.Command("systemctl", "is-active", name)
	out, _ := cmd.Output()
	status := strings.TrimSpace(string(out))
	switch status {
	case "active":
		return "running"
	case "inactive":
		return "stopped"
	case "failed":
		return "failed"
	default:
		return status
	}
}
