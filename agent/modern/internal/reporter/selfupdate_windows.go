//go:build windows

package reporter

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// applyUpdate writes the new binary to a temp file, drops a self-deleting batch
// file, and launches it as a detached process.  The batch stops the service,
// replaces the exe, and restarts it — all without PowerShell or Task Scheduler,
// which are unreliable on domain controllers with restrictive execution policies.
func applyUpdate(newBinary []byte) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get exe path: %w", err)
	}
	dir := filepath.Dir(exePath)

	// Write new binary alongside the running exe
	tmpExe := filepath.Join(dir, "kifaa-agent-new.exe")
	if err := os.WriteFile(tmpExe, newBinary, 0755); err != nil {
		return fmt.Errorf("write new binary: %w", err)
	}

	// Batch file — uses only built-in cmd.exe commands, no PowerShell required.
	// "ping -n N 127.0.0.1" is the classic Windows batch sleep (~1 s per ping).
	batPath := filepath.Join(dir, "kifaa-update.bat")
	bat := fmt.Sprintf(
		"@echo off\r\n"+
			// Wait ~7 s so the current agent process can finish its current work
			"ping -n 8 127.0.0.1 >nul\r\n"+
			// Force-stop the service (net stop waits for stop to complete)
			"net stop KifaaAgent\r\n"+
			// Extra wait in case the service is slow to release the file lock
			"ping -n 4 127.0.0.1 >nul\r\n"+
			// Replace the binary
			"copy /y \"%s\" \"%s\"\r\n"+
			// Clean up the temp copy
			"del /f \"%s\"\r\n"+
			// Restore permissions
			"icacls \"%s\" /grant \"SYSTEM:(F)\" \"Administrators:(F)\" \"Users:(RX)\" >nul\r\n"+
			// Restart the service
			"net start KifaaAgent\r\n"+
			// Self-delete this batch file
			"(goto) 2>nul & del \"%%~f0\"\r\n",
		tmpExe, exePath, tmpExe, exePath,
	)
	if err := os.WriteFile(batPath, []byte(bat), 0644); err != nil {
		return fmt.Errorf("write update batch: %w", err)
	}

	// Launch the batch file as a fully detached process so it survives the
	// service stopping.  CREATE_NEW_PROCESS_GROUP ensures it has its own
	// process group; CREATE_NO_WINDOW keeps it invisible.
	cmd := exec.Command("cmd.exe", "/c", batPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000200 | 0x08000000, // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
	}
	if err := cmd.Start(); err != nil {
		// Clean up on failure
		os.Remove(batPath)
		os.Remove(tmpExe)
		return fmt.Errorf("launch update batch: %w", err)
	}
	// Do NOT call cmd.Wait() — we want the batch to outlive the service process.
	// Go's GC will clean up the os.Process handle.
	return nil
}

// Ensure exec is imported (used above)
var _ = exec.Command
