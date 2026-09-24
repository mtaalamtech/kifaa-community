//go:build windows

package main

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"

	"kifaa-agent/internal/config"
)

//go:embed kifaa.ico
var kifaaIconBytes []byte

// registerUninstallEntry writes a Programs and Features (Add/Remove Programs) entry
// and creates an uninstall.bat in the install directory.
// Silently ignored if registry access fails (e.g. running without elevation).
func registerUninstallEntry() {
	const keyPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KifaaAgent`
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, keyPath, registry.ALL_ACCESS)
	if err != nil {
		return
	}
	defer k.Close()

	exePath, _ := os.Executable()
	installDir := ""
	if exePath != "" {
		installDir = filepath.Dir(exePath)
	}

	uninstallBat := filepath.Join(installDir, "uninstall.bat")

	// Write uninstall.bat — copies itself to %TEMP% first so it can delete the install dir
	batContent := "@echo off\r\n" +
		"sc stop KifaaAgent >nul 2>&1\r\n" +
		"sc delete KifaaAgent >nul 2>&1\r\n" +
		"taskkill /f /im kifaa-agent.exe >nul 2>&1\r\n" +
		"timeout /t 2 /nobreak >nul\r\n" +
		"copy \"%~f0\" \"%TEMP%\\kifaa_uninst_run.bat\" >nul\r\n" +
		fmt.Sprintf("start \"\" /b cmd /c \"%%TEMP%%\\kifaa_uninst_run.bat\" \"%s\"\r\n", installDir) +
		"exit /b\r\n" +
		":phase2\r\n" +
		"timeout /t 2 /nobreak >nul\r\n" +
		fmt.Sprintf("rd /s /q \"%s\" >nul 2>&1\r\n", installDir) +
		"reg delete \"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KifaaAgent\" /f >nul 2>&1\r\n" +
		"del \"%TEMP%\\kifaa_uninst_run.bat\" >nul 2>&1\r\n"

	if installDir != "" {
		if err := os.WriteFile(uninstallBat, []byte(batContent), 0644); err != nil {
			// If we can't write the bat, fall back to inline command
			uninstallBat = ""
		}
	}

	date := time.Now().Format("20060102")

	_ = k.SetStringValue("DisplayName", "Kifaa Agent")
	_ = k.SetStringValue("DisplayVersion", config.AgentVersion)
	_ = k.SetStringValue("Publisher", "Kifaa")
	_ = k.SetStringValue("InstallDate", date)
	if installDir != "" {
		_ = k.SetStringValue("InstallLocation", installDir)
	}

	if uninstallBat != "" {
		_ = k.SetStringValue("UninstallString",
			fmt.Sprintf(`cmd.exe /c "%s"`, uninstallBat))
	} else {
		_ = k.SetStringValue("UninstallString",
			fmt.Sprintf(`sc stop KifaaAgent && sc delete KifaaAgent && rd /s /q "%s"`, installDir))
	}

	// Write the embedded Kifaa icon to disk so Programs & Features can display it.
	// Windows requires the DisplayIcon to point to a file with an actual icon resource;
	// Go binaries don't embed icons by default, so we ship the .ico alongside the exe.
	iconPath := ""
	if installDir != "" {
		iconPath = filepath.Join(installDir, "kifaa.ico")
		if err := os.WriteFile(iconPath, kifaaIconBytes, 0644); err != nil {
			iconPath = ""
		}
	}
	if iconPath != "" {
		_ = k.SetStringValue("DisplayIcon", iconPath)
	} else {
		_ = k.SetStringValue("DisplayIcon", exePath)
	}
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	_ = k.SetDWordValue("EstimatedSize", 20480) // ~20 MB in KB
}

// runAgentPlatform detects whether the process was started by the Windows
// Service Control Manager and either runs as a proper Windows service or
// as a plain process (for interactive testing / --register mode).
func runAgentPlatform(cfg *config.Config) {
	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Printf("svc.IsWindowsService: %v — running in console mode", err)
		isService = false
	}

	if isService {
		if err := svc.Run("KifaaAgent", &kifaaSvc{cfg: cfg}); err != nil {
			log.Fatalf("Service failed: %v", err)
		}
		return
	}

	// Console / process mode — also register uninstall entry
	registerUninstallEntry()
	runAgent(cfg, nil)
}

// kifaaSvc implements svc.Handler so the Windows SCM can start/stop the agent.
type kifaaSvc struct {
	cfg *config.Config
}

func (s *kifaaSvc) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {

	status <- svc.Status{State: svc.StartPending}

	// Ensure Programs and Features entry exists
	registerUninstallEntry()

	stop := make(chan struct{})
	go runAgent(s.cfg, stop)

	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	for req := range requests {
		switch req.Cmd {
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			close(stop)
			return false, 0
		default:
			status <- svc.Status{
				State:   svc.Running,
				Accepts: svc.AcceptStop | svc.AcceptShutdown,
			}
		}
	}
	return false, 0
}
