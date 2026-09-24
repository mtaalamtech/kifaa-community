//go:build linux

package collector

import (
	"bufio"
	"os/exec"
	"strings"
)

type ServiceInfo struct {
	ServiceName string `json:"service_name"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	StartupType string `json:"startup_type"`
	PID         int    `json:"pid,omitempty"`
	ExePath     string `json:"exe_path,omitempty"`
}

func CollectServices() []ServiceInfo {
	var services []ServiceInfo

	// Use systemctl to list all units
	cmd := exec.Command("systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend")
	out, err := cmd.Output()
	if err != nil {
		return services
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		name := strings.TrimSuffix(fields[0], ".service")
		// fields: UNIT LOAD ACTIVE SUB DESCRIPTION
		active := fields[2]
		sub := fields[3]

		status := "stopped"
		if active == "active" && sub == "running" {
			status = "running"
		} else if active == "activating" {
			status = "starting"
		} else if active == "deactivating" {
			status = "stopping"
		} else if active == "failed" {
			status = "failed"
		}

		startupType := getStartupType(name)

		services = append(services, ServiceInfo{
			ServiceName: name,
			DisplayName: name,
			Status:      status,
			StartupType: startupType,
		})
	}
	return services
}

func getStartupType(serviceName string) string {
	cmd := exec.Command("systemctl", "is-enabled", serviceName+".service")
	out, _ := cmd.Output()
	result := strings.TrimSpace(string(out))
	switch result {
	case "enabled":
		return "automatic"
	case "disabled":
		return "disabled"
	case "static":
		return "static"
	default:
		return "manual"
	}
}
