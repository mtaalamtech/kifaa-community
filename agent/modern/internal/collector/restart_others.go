//go:build !windows

package collector

import (
	"fmt"
	"os/exec"
	"strconv"
)

// RestartMachine schedules a system restart or power off.
// mode "poweroff"  → immediate power off (shutdown -h now)
// mode "silent"    → immediate restart, no wall message
// mode "announced" → broadcasts a warning message then restarts after delaySecs
func RestartMachine(mode string, delaySecs int) error {
	if delaySecs <= 0 {
		delaySecs = 60
	}

	if mode == "poweroff" {
		out, err := exec.Command("shutdown", "-h", "now").CombinedOutput()
		if err != nil {
			return fmt.Errorf("shutdown failed: %w — %s", err, string(out))
		}
		return nil
	}

	if mode == "silent" {
		out, err := exec.Command("shutdown", "-r", "now").CombinedOutput()
		if err != nil {
			return fmt.Errorf("shutdown failed: %w — %s", err, string(out))
		}
		return nil
	}

	// announced: broadcast wall message then schedule restart
	msg := fmt.Sprintf("NOTICE: This system will restart in %d seconds. Please save your work.", delaySecs)
	_ = exec.Command("wall", msg).Run()

	delayMins := delaySecs / 60
	if delayMins < 1 {
		delayMins = 1
	}
	out, err := exec.Command("shutdown", "-r", "+"+strconv.Itoa(delayMins),
		fmt.Sprintf("Kifaa: system restart in %d minute(s)", delayMins)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown failed: %w — %s", err, string(out))
	}
	return nil
}
