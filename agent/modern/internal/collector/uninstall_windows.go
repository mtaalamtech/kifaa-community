//go:build windows

package collector

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

type UninstallResult struct {
	Name           string `json:"name"`
	Success        bool   `json:"success"`
	Output         string `json:"output"`
	Message        string `json:"message"`
	UninstallJobId string `json:"uninstall_job_id,omitempty"`
}

var uninstallRegPaths = []registry.Key{
	registry.LOCAL_MACHINE,
	registry.CURRENT_USER,
}

var uninstallSubKeys = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

const uninstallTimeout = 10 * time.Minute

func UninstallSoftware(name, version, jobID string) UninstallResult {
	var res UninstallResult
	// Search registry for matching app
	for _, root := range uninstallRegPaths {
		for _, subKey := range uninstallSubKeys {
			r := tryRegistryUninstall(root, subKey, name, version)
			if r != nil {
				res = *r
				res.UninstallJobId = jobID
				return res
			}
		}
	}

	// Last resort: wmic (slow — only used when registry lookup fails; has 10-min timeout)
	res = wmicUninstall(name)
	res.UninstallJobId = jobID
	return res
}

func tryRegistryUninstall(root registry.Key, subKey, targetName, targetVersion string) *UninstallResult {
	k, err := registry.OpenKey(root, subKey, registry.READ)
	if err != nil {
		return nil
	}
	defer k.Close()

	subNames, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil
	}

	for _, sub := range subNames {
		sk, err := registry.OpenKey(k, sub, registry.READ)
		if err != nil {
			continue
		}

		displayName, _, _ := sk.GetStringValue("DisplayName")
		displayVersion, _, _ := sk.GetStringValue("DisplayVersion")
		quietUninstall, _, _ := sk.GetStringValue("QuietUninstallString")
		uninstallStr, _, _ := sk.GetStringValue("UninstallString")
		sk.Close()

		if !strings.EqualFold(displayName, targetName) {
			continue
		}
		if targetVersion != "" && !strings.EqualFold(displayVersion, targetVersion) {
			continue
		}

		// Prefer QuietUninstallString
		if quietUninstall != "" {
			out, err := runUninstallCmd(quietUninstall)
			success := err == nil
			msg := "Uninstalled via QuietUninstallString"
			if !success {
				msg = fmt.Sprintf("Quiet uninstall failed: %v", err)
			}
			return &UninstallResult{Name: targetName, Success: success, Output: out, Message: msg}
		}

		// Parse MSI GUID from UninstallString
		if uninstallStr != "" {
			if strings.Contains(strings.ToLower(uninstallStr), "msiexec") {
				guid := extractMSIGUID(uninstallStr)
				if guid != "" {
					ctx, cancel := context.WithTimeout(context.Background(), uninstallTimeout)
					defer cancel()
					cmd := exec.CommandContext(ctx, "msiexec", "/x", guid, "/qn", "/norestart")
					out, err := cmd.CombinedOutput()
					if ctx.Err() != nil {
						err = fmt.Errorf("timed out after %v", uninstallTimeout)
					}
					success := err == nil || isRebootRequired(cmd)
					return &UninstallResult{
						Name:    targetName,
						Success: success,
						Output:  strings.TrimSpace(string(out)),
						Message: fmt.Sprintf("MSI uninstall (%s)", guid),
					}
				}
			}

			// Non-MSI: try each major installer framework's silent flag in order.
			// Appending all flags at once causes some installers (BitRock, InstallShield)
			// to reject the command. We stop at the first success or first meaningful failure.
			silentVariants := []struct {
				flags string
				label string
			}{
				{" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART", "Inno Setup silent"},
				{" /S", "NSIS silent"},
				{" --mode unattended", "InstallBuilder unattended"},
				{" /quiet /norestart", "Generic quiet"},
				{"", "raw (no flags)"},
			}
			for _, v := range silentVariants {
				out, err := runUninstallCmd(uninstallStr + v.flags)
				if err == nil {
					return &UninstallResult{Name: targetName, Success: true, Output: out,
						Message: fmt.Sprintf("Uninstall succeeded (%s)", v.label)}
				}
				lower := strings.ToLower(out)
				// If output is empty or contains "invalid"/"unknown", the flags were likely
				// rejected — try the next variant. Otherwise accept this as a real failure.
				if len(out) == 0 || strings.Contains(lower, "invalid") || strings.Contains(lower, "unknown option") {
					if v.flags != "" {
						continue
					}
				}
				return &UninstallResult{Name: targetName, Success: false, Output: out,
					Message: fmt.Sprintf("Uninstall failed (%s): %v", v.label, err)}
			}
			return &UninstallResult{Name: targetName, Success: false, Output: "",
				Message: "All uninstall attempts failed — no silent flag accepted"}
		}
	}
	return nil
}

// runUninstallCmd runs an uninstall command string with a hard 10-minute timeout.
// WaitDelay on exec.Cmd only works when a context is set; this function uses
// context.WithTimeout so the process is always killed if it hangs.
func runUninstallCmd(cmdStr string) (string, error) {
	// Split into executable + args; handle quoted paths
	var args []string
	if strings.HasPrefix(cmdStr, `"`) {
		end := strings.Index(cmdStr[1:], `"`)
		if end >= 0 {
			exe := cmdStr[1 : end+1]
			rest := strings.TrimSpace(cmdStr[end+2:])
			args = append([]string{exe}, strings.Fields(rest)...)
		}
	}
	if len(args) == 0 {
		args = strings.Fields(cmdStr)
	}
	if len(args) == 0 {
		return "", fmt.Errorf("empty command")
	}

	ctx, cancel := context.WithTimeout(context.Background(), uninstallTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return strings.TrimSpace(string(out)), fmt.Errorf("timed out after %v", uninstallTimeout)
	}
	return strings.TrimSpace(string(out)), err
}

func extractMSIGUID(s string) string {
	start := strings.Index(s, "{")
	end := strings.Index(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

func isRebootRequired(cmd *exec.Cmd) bool {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode() == 3010
	}
	return false
}

func wmicUninstall(name string) UninstallResult {
	// Escape double quotes in name
	safeName := strings.ReplaceAll(name, `"`, `\"`)
	cmdStr := fmt.Sprintf(`wmic product where name="%s" call uninstall /nointeractive`, safeName)
	ctx, cancel := context.WithTimeout(context.Background(), uninstallTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cmd", "/C", cmdStr)
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return UninstallResult{
			Name:    name,
			Success: false,
			Output:  strings.TrimSpace(string(out)),
			Message: fmt.Sprintf("WMIC timed out after %v — product may not exist in WMI", uninstallTimeout),
		}
	}
	output := strings.TrimSpace(string(out))
	success := err == nil && strings.Contains(strings.ToLower(output), "retval = 0")
	msg := "Uninstalled via wmic"
	if !success {
		msg = fmt.Sprintf("WMIC uninstall failed: %v", err)
	}
	return UninstallResult{
		Name:    name,
		Success: success,
		Output:  output,
		Message: msg,
	}
}
