//go:build windows

package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type InstallResult struct {
	JobID   string `json:"deploy_job_id"`
	Name    string `json:"name"`
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Message string `json:"message"`
}

func InstallSoftware(jobID, name, downloadURL, installArgs, checksum, installerType string) InstallResult {
	// Create temp dir
	tmpDir := filepath.Join(os.TempDir(), "kifaa-deploy", jobID)
	if err := os.MkdirAll(tmpDir, 0700); err != nil {
		return InstallResult{JobID: jobID, Name: name, Success: false, Message: "create temp dir: " + err.Error()}
	}
	defer os.RemoveAll(tmpDir)

	// Determine filename from URL
	parts := strings.Split(downloadURL, "/")
	filename := parts[len(parts)-1]
	if filename == "" {
		filename = "installer"
	}
	destPath := filepath.Join(tmpDir, filename)

	// Download
	if err := downloadFile(downloadURL, destPath); err != nil {
		return InstallResult{JobID: jobID, Name: name, Success: false, Message: "download failed: " + err.Error()}
	}

	// Verify checksum if provided
	if checksum != "" {
		if err := verifySHA256(destPath, checksum); err != nil {
			return InstallResult{JobID: jobID, Name: name, Success: false, Message: "checksum mismatch: " + err.Error()}
		}
	}

	// Run installer
	output, err := runInstaller(destPath, installerType, installArgs)
	success := err == nil
	msg := "Installation succeeded"
	if !success {
		msg = fmt.Sprintf("Installation failed: %v", err)
	}
	return InstallResult{JobID: jobID, Name: name, Success: success, Output: output, Message: msg}
}

func runInstaller(path, installerType, args string) (string, error) {
	var cmd *exec.Cmd
	switch strings.ToLower(installerType) {
	case "msi":
		msiArgs := []string{"/i", path, "/qn", "/norestart"}
		if args != "" {
			msiArgs = append(msiArgs, strings.Fields(args)...)
		}
		cmd = exec.Command("msiexec", msiArgs...)
	case "ps1":
		psArgs := []string{"-ExecutionPolicy", "Bypass", "-File", path}
		if args != "" {
			psArgs = append(psArgs, strings.Fields(args)...)
		}
		cmd = exec.Command("powershell", psArgs...)
	default: // exe, zip+exe, etc.
		defaultArgs := []string{"/S", "/silent", "/SILENT", "/VERYSILENT", "/quiet"}
		if args != "" {
			defaultArgs = strings.Fields(args)
		}
		cmd = exec.Command(path, defaultArgs...)
	}
	cmd.WaitDelay = 10 * time.Minute
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	// MSI exit code 3010 = success + reboot needed
	if err != nil && cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 3010 {
		return output + "\n[REBOOT REQUIRED]", nil
	}
	return output, err
}

func downloadFile(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func verifySHA256(path, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, expected) {
		return fmt.Errorf("expected %s got %s", expected, got)
	}
	return nil
}
