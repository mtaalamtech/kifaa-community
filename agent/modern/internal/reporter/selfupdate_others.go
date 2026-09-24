//go:build !windows

package reporter

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// applyUpdate atomically replaces the current binary and re-execs the process.
func applyUpdate(newBinary []byte) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get exe path: %w", err)
	}

	// Write to a temp file next to the exe, then rename (atomic on Linux)
	tmp := exePath + ".new"
	if err := os.WriteFile(tmp, newBinary, 0755); err != nil {
		return fmt.Errorf("write new binary: %w", err)
	}
	if err := os.Rename(tmp, exePath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("replace binary: %w", err)
	}

	// Re-exec: systemd will restart the service on exit
	args := os.Args
	env := os.Environ()
	if err := syscall.Exec(filepath.Clean(exePath), args, env); err != nil {
		return fmt.Errorf("re-exec: %w", err)
	}
	return nil // unreachable after Exec
}

// Ensure exec is imported (used in Exec call above)
var _ = exec.Command
