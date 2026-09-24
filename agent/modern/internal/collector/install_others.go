//go:build !windows && !linux

package collector

type InstallResult struct {
	JobID   string `json:"deploy_job_id"`
	Name    string `json:"name"`
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Message string `json:"message"`
}

func InstallSoftware(jobID, name, downloadURL, installArgs, checksum, installerType string) InstallResult {
	return InstallResult{JobID: jobID, Name: name, Success: false, Message: "software install not supported on this platform"}
}
