//go:build windows

package collector

import (
	"fmt"
	"os/exec"
	"strconv"
)

// RestartMachine schedules a system restart or power off.
// mode "poweroff"  → shutdown /s /t 0 /f (immediate power off)
// mode "silent"    → shutdown /r /t 0 (immediate, no message)
// mode "announced" → shutdown /r /t <delaySecs> /c "message"
func RestartMachine(mode string, delaySecs int) error {
	if delaySecs <= 0 {
		delaySecs = 60
	}

	var args []string
	if mode == "poweroff" {
		args = []string{"/s", "/t", "0", "/f"}
	} else if mode == "silent" {
		args = []string{"/r", "/t", "0", "/f"}
	} else {
		msg := fmt.Sprintf("Kifaa: This system will restart in %d seconds. Please save your work.", delaySecs)
		args = []string{"/r", "/t", strconv.Itoa(delaySecs), "/c", msg, "/f"}
	}

	out, err := exec.Command("shutdown", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown failed: %w — %s", err, string(out))
	}
	return nil
}
