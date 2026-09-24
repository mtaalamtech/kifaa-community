//go:build !windows && !linux

package collector

import "errors"

type ServiceControlResult struct {
	ServiceName string `json:"service_name"`
	Action      string `json:"action"`
	Success     bool   `json:"success"`
	NewStatus   string `json:"new_status"`
	Message     string `json:"message"`
}

func ControlService(name, action string) ServiceControlResult {
	_ = errors.New("not supported")
	return ServiceControlResult{ServiceName: name, Action: action, Success: false, Message: "service control not supported on this platform"}
}
