//go:build linux

package collector

import (
	"fmt"
	"os/exec"
	"strings"
)

type UninstallResult struct {
	Name           string `json:"name"`
	Success        bool   `json:"success"`
	Output         string `json:"output"`
	Message        string `json:"message"`
	UninstallJobId string `json:"uninstall_job_id,omitempty"`
}

func UninstallSoftware(name, version, jobID string) UninstallResult {
	// Check dpkg
	chk := exec.Command("dpkg-query", "-W", "-f=${Status}", name)
	out, err := chk.Output()
	if err == nil && strings.Contains(string(out), "install ok installed") {
		r := dpkgUninstall(name)
		r.UninstallJobId = jobID
		return r
	}

	// Check rpm
	rpmChk := exec.Command("rpm", "-q", name)
	if rpmChk.Run() == nil {
		r := rpmUninstall(name)
		r.UninstallJobId = jobID
		return r
	}

	return UninstallResult{
		Name:           name,
		Success:        false,
		Message:        fmt.Sprintf("package '%s' not found in dpkg or rpm", name),
		UninstallJobId: jobID,
	}
}

func dpkgUninstall(name string) UninstallResult {
	cmd := exec.Command("dpkg", "-P", "--force-depends", name)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		return UninstallResult{Name: name, Success: false, Output: output, Message: fmt.Sprintf("dpkg -P failed: %v", err)}
	}
	return UninstallResult{Name: name, Success: true, Output: output, Message: "Removed via dpkg"}
}

func rpmUninstall(name string) UninstallResult {
	cmd := exec.Command("rpm", "-e", name)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		return UninstallResult{Name: name, Success: false, Output: output, Message: fmt.Sprintf("rpm -e failed: %v", err)}
	}
	return UninstallResult{Name: name, Success: true, Output: output, Message: "Removed via rpm"}
}
