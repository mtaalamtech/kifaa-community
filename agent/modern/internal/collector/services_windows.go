//go:build windows

package collector

import (
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/svc/mgr"
)

type ServiceInfo struct {
	ServiceName string `json:"service_name"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	StartupType string `json:"startup_type"`
	PID         int    `json:"pid,omitempty"`
	ExePath     string `json:"exe_path,omitempty"`
}

// CollectServices lists Windows services via SCM, falling back to sc.exe query
// if the SCM connection fails or returns an empty list (e.g. limited privileges).
func CollectServices() []ServiceInfo {
	services := collectViaSCM()
	if len(services) > 0 {
		return services
	}
	return collectViaSCExe()
}

func collectViaSCM() []ServiceInfo {
	var services []ServiceInfo

	m, err := mgr.Connect()
	if err != nil {
		return services
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil || len(names) == 0 {
		return services
	}

	for _, name := range names {
		svc, err := m.OpenService(name)
		if err != nil {
			continue
		}

		status, statusErr := svc.Query()
		config, _ := svc.Config()
		svc.Close()

		if statusErr != nil {
			continue
		}

		services = append(services, ServiceInfo{
			ServiceName: name,
			DisplayName: config.DisplayName,
			Status:      svcStateStr(uint32(status.State)),
			StartupType: svcStartStr(config.StartType),
			ExePath:     config.BinaryPathName,
		})
	}
	return services
}

// collectViaSCExe uses `sc.exe query type= all state= all` as a fallback.
func collectViaSCExe() []ServiceInfo {
	var services []ServiceInfo

	out, err := exec.Command("sc.exe", "query", "type=", "all", "state=", "all",
		"bufsize=", "524288").Output()
	if err != nil {
		// Try without bufsize flag (older Windows)
		out, err = exec.Command("sc.exe", "query", "type=", "all", "state=", "all").Output()
		if err != nil {
			return services
		}
	}

	var current ServiceInfo
	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "SERVICE_NAME:"):
			if current.ServiceName != "" {
				services = append(services, current)
			}
			current = ServiceInfo{
				ServiceName: strings.TrimSpace(strings.TrimPrefix(line, "SERVICE_NAME:")),
			}
		case strings.HasPrefix(line, "DISPLAY_NAME:"):
			current.DisplayName = strings.TrimSpace(strings.TrimPrefix(line, "DISPLAY_NAME:"))
		case strings.HasPrefix(line, "STATE"):
			// e.g. "STATE              : 4  RUNNING"
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				current.Status = strings.ToLower(parts[len(parts)-1])
			}
		case strings.HasPrefix(line, "TYPE"):
			// TYPE               : 10  WIN32_OWN_PROCESS
			// leave StartupType as empty — sc query doesn't give startup type
		}
	}
	if current.ServiceName != "" {
		services = append(services, current)
	}

	// Get startup types for each service via individual sc qc calls.
	// Only do this for a reasonable number of services to avoid slowness.
	if len(services) <= 300 {
		for i := range services {
			startup := getStartupType(services[i].ServiceName)
			if startup != "" {
				services[i].StartupType = startup
			}
		}
	}

	return services
}

func getStartupType(name string) string {
	out, err := exec.Command("sc.exe", "qc", name, "512").Output()
	if err != nil {
		return ""
	}
	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "START_TYPE") {
			// e.g. "START_TYPE         : 2   AUTO_START"
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				t := strings.ToLower(parts[len(parts)-1])
				switch {
				case strings.Contains(t, "auto"):
					return "automatic"
				case strings.Contains(t, "demand"):
					return "manual"
				case strings.Contains(t, "disabled"):
					return "disabled"
				case strings.Contains(t, "boot"):
					return "boot"
				case strings.Contains(t, "system"):
					return "system"
				}
			}
		}
	}
	return ""
}

func svcStateStr(state uint32) string {
	switch state {
	case 1:
		return "stopped"
	case 2:
		return "starting"
	case 3:
		return "stopping"
	case 4:
		return "running"
	case 5:
		return "continue_pending"
	case 6:
		return "pause_pending"
	case 7:
		return "paused"
	default:
		return "unknown"
	}
}

func svcStartStr(startType uint32) string {
	switch startType {
	case 0:
		return "boot"
	case 1:
		return "system"
	case 2:
		return "automatic"
	case 3:
		return "manual"
	case 4:
		return "disabled"
	default:
		return "manual"
	}
}
