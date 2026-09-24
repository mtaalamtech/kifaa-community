//go:build !windows && !linux

package collector

type UninstallResult struct {
	Name           string `json:"name"`
	Success        bool   `json:"success"`
	Output         string `json:"output"`
	Message        string `json:"message"`
	UninstallJobId string `json:"uninstall_job_id,omitempty"`
}

func UninstallSoftware(name, version, jobID string) UninstallResult {
	return UninstallResult{Name: name, Success: false, Message: "software uninstall not supported on this platform", UninstallJobId: jobID}
}
