//go:build linux

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
	tmpDir := filepath.Join("/tmp", "kifaa-deploy", jobID)
	if err := os.MkdirAll(tmpDir, 0700); err != nil {
		return InstallResult{JobID: jobID, Name: name, Success: false, Message: "create temp dir: " + err.Error()}
	}
	defer os.RemoveAll(tmpDir)

	parts := strings.Split(downloadURL, "/")
	filename := parts[len(parts)-1]
	if filename == "" {
		filename = "installer"
	}
	destPath := filepath.Join(tmpDir, filename)

	if err := downloadFile(downloadURL, destPath); err != nil {
		return InstallResult{JobID: jobID, Name: name, Success: false, Message: "download failed: " + err.Error()}
	}

	if checksum != "" {
		if err := verifySHA256(destPath, checksum); err != nil {
			return InstallResult{JobID: jobID, Name: name, Success: false, Message: "checksum mismatch: " + err.Error()}
		}
	}

	output, err := runLinuxInstaller(destPath, installerType, installArgs)
	success := err == nil
	msg := "Installation succeeded"
	if !success {
		msg = fmt.Sprintf("Installation failed: %v", err)
	}
	return InstallResult{JobID: jobID, Name: name, Success: success, Output: output, Message: msg}
}

func runLinuxInstaller(path, installerType, args string) (string, error) {
	var cmd *exec.Cmd
	switch strings.ToLower(installerType) {
	case "deb":
		// apt-get handles dependencies better than bare dpkg
		cmdArgs := []string{"install", "-y", path}
		if args != "" {
			cmdArgs = append(cmdArgs, strings.Fields(args)...)
		}
		cmd = exec.Command("apt-get", cmdArgs...)
		if _, err := exec.LookPath("apt-get"); err != nil {
			cmd = exec.Command("dpkg", "-i", path)
		}
	case "rpm":
		cmdArgs := []string{"install", "-y", path}
		if args != "" {
			cmdArgs = append(cmdArgs, strings.Fields(args)...)
		}
		// Try dnf, then yum, then rpm
		if _, err := exec.LookPath("dnf"); err == nil {
			cmd = exec.Command("dnf", cmdArgs...)
		} else if _, err := exec.LookPath("yum"); err == nil {
			cmd = exec.Command("yum", cmdArgs...)
		} else {
			cmd = exec.Command("rpm", "-Uvh", path)
		}
	case "sh", "bash":
		os.Chmod(path, 0700)
		var cmdArgs []string
		if args != "" {
			cmdArgs = strings.Fields(args)
		}
		cmd = exec.Command("bash", append([]string{path}, cmdArgs...)...)
	default:
		os.Chmod(path, 0700)
		var cmdArgs []string
		if args != "" {
			cmdArgs = strings.Fields(args)
		}
		cmd = exec.Command(path, cmdArgs...)
	}
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	timeout := 10 * time.Minute
	_ = timeout
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
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
