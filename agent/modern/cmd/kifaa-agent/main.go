package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"kifaa-agent/internal/collector"
	"kifaa-agent/internal/config"
	"kifaa-agent/internal/reporter"
)

var (
	flagRegister = flag.Bool("register", false, "Register this agent with the server")
	flagServer   = flag.String("server", "", "Server URL (e.g. http://kifaa.kenyanut.com)")
	flagSecret   = flag.String("secret", "", "Registration secret")
	flagVersion  = flag.Bool("version", false, "Print agent version")
)

func main() {
	flag.Parse()

	if *flagVersion {
		fmt.Printf("Kifaa Agent v%s\n", config.AgentVersion)
		os.Exit(0)
	}

	// Registration mode
	if *flagRegister {
		if *flagServer == "" || *flagSecret == "" {
			log.Fatal("--register requires --server and --secret flags")
		}
		runRegister(*flagServer, *flagSecret)
		return
	}

	// Normal run mode — load config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v\nRun with --register to set up agent.", err)
	}

	runAgentPlatform(cfg)
}

func runRegister(serverURL, secret string) {
	cfg := config.DefaultConfig()
	cfg.ServerURL = serverURL
	cfg.RegistrationSecret = secret

	sysInfo, err := collector.GetSystemInfo()
	if err != nil {
		log.Fatalf("Failed to get system info: %v", err)
	}

	log.Printf("Registering agent '%s' with server %s...", sysInfo.Hostname, serverURL)

	rep := reporter.New(cfg)
	resp, err := rep.Register(sysInfo)
	if err != nil {
		log.Fatalf("Registration failed: %v", err)
	}

	cfg.AgentID = resp.AgentID
	cfg.APIKey = resp.APIKey

	if err := config.Save(cfg); err != nil {
		log.Fatalf("Failed to save config: %v", err)
	}

	log.Printf("Registration successful!")
	log.Printf("  Agent ID : %s", resp.AgentID)
	log.Printf("  Config   : %s", config.ConfigPath())
	log.Println("You can now start the agent service.")
}

// runAgent runs the main agent loop. stop may be nil (run forever) or a
// channel that is closed to request a clean shutdown (Windows service mode).
func runAgent(cfg *config.Config, stop <-chan struct{}) {
	log.Printf("Kifaa Agent v%s starting — server: %s", config.AgentVersion, cfg.ServerURL)

	rep := reporter.New(cfg)

	// Get initial system info
	sysInfo, err := collector.GetSystemInfo()
	if err != nil {
		log.Printf("WARNING: could not get system info: %v", err)
	}

	heartbeatTicker := time.NewTicker(time.Duration(cfg.HeartbeatInterval) * time.Second)
	inventoryTicker := time.NewTicker(time.Duration(cfg.InventoryInterval) * time.Second)
	// Fast poll: check for pending commands every 5 seconds without sending metrics.
	// This makes user-initiated actions (unlock, enable, disable, ad_sync) near-immediate.
	commandPollTicker := time.NewTicker(5 * time.Second)
	defer heartbeatTicker.Stop()
	defer inventoryTicker.Stop()
	defer commandPollTicker.Stop()

	// Run inventory on startup
	go sendInventory(rep)

	for {
		select {
		case <-commandPollTicker.C:
			pollAndProcessCommands(rep)

		case <-heartbeatTicker.C:
			sendHeartbeat(rep, sysInfo)

		case <-inventoryTicker.C:
			go sendInventory(rep)

			// Refresh IP in case it changed
			if newInfo, err := collector.GetSystemInfo(); err == nil {
				sysInfo = newInfo
			}

		case <-stop: // nil channel blocks forever — safe to use here
			log.Printf("Kifaa Agent stopping.")
			return
		}
	}
}

// pollAndProcessCommands hits the lightweight /agents/commands endpoint and
// processes any returned commands. This runs every 5 seconds so user-initiated
// actions (unlock, sync, etc.) are picked up almost immediately.
func pollAndProcessCommands(rep *reporter.Reporter) {
	cmds, err := rep.PollCommands()
	if err != nil || len(cmds) == 0 {
		return
	}
	log.Printf("Fast poll: %d command(s) received", len(cmds))
	processCommands(rep, cmds)
}

func sendHeartbeat(rep *reporter.Reporter, sysInfo *collector.SystemInfo) {
	metrics := collector.CollectMetrics()
	services := collector.CollectServices()
	restartPending := collector.CheckRebootPending()

	ipAddr := ""
	if sysInfo != nil {
		ipAddr = sysInfo.IPAddress
	}

	resp, err := rep.SendHeartbeat(metrics, services, ipAddr, restartPending, sysInfo)
	if err != nil {
		log.Printf("Heartbeat error: %v", err)
		return
	}
	log.Printf("Heartbeat sent — %d metrics, %d services", len(metrics), len(services))

	processCommands(rep, resp.PendingCommands)
}

// safeGo launches fn in a goroutine with a deferred panic recovery so that a
// bug or nil-pointer in any command handler cannot crash the whole service.
func safeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("PANIC in %s (recovered): %v", name, r)
			}
		}()
		fn()
	}()
}

// processCommands handles the slice of pending commands returned by either
// the heartbeat or the fast command-poll endpoint.
func processCommands(rep *reporter.Reporter, cmds []reporter.PendingCommand) {
	for _, cmd := range cmds {
		switch cmd.Type {
		case "patch_scan":
			log.Printf("Command received: patch_scan")
			safeGo("patch_scan", func() { runPatchScan(rep) })
		case "apply_patches":
			jobID, _ := cmd.Payload["job_id"].(string)
			pkgsRaw, _ := cmd.Payload["packages"].([]interface{})
			var pkgs []string
			for _, p := range pkgsRaw {
				if s, ok := p.(string); ok && s != "" {
					pkgs = append(pkgs, s)
				}
			}
			rebootAfter, _ := cmd.Payload["reboot_after"].(bool)
			rebootMode, _ := cmd.Payload["reboot_mode"].(string)
			if rebootMode == "" {
				rebootMode = "silent"
			}
			rebootDelay := 60
			if d, ok := cmd.Payload["reboot_delay_seconds"].(float64); ok && d > 0 {
				rebootDelay = int(d)
			}
			if len(pkgs) > 0 {
				log.Printf("Command received: apply_patches — %d package(s), job_id=%s reboot_after=%v", len(pkgs), jobID, rebootAfter)
				safeGo("apply_patches", func() { runApplyPatches(rep, jobID, pkgs, rebootAfter, rebootMode, rebootDelay) })
			}
		case "update_agent":
			url, _ := cmd.Payload["url"].(string)
			if url != "" {
				log.Printf("Command received: update_agent — downloading new binary")
				safeGo("update_agent", func() { runSelfUpdate(rep, url) })
			}
		case "restart_machine":
			mode, _ := cmd.Payload["mode"].(string)
			if mode == "" {
				mode = "silent"
			}
			delay := 60
			if d, ok := cmd.Payload["delay_seconds"].(float64); ok && d > 0 {
				delay = int(d)
			}
			log.Printf("Command received: restart_machine — mode=%s delay=%ds", mode, delay)
			safeGo("restart_machine", func() { runRestartMachine(mode, delay) })
		case "ad_sync":
			dcHost, _ := cmd.Payload["dc_host"].(string)
			baseDN, _ := cmd.Payload["base_dn"].(string)
			username, _ := cmd.Payload["username"].(string)
			password, _ := cmd.Payload["password"].(string)
			useSSL, _ := cmd.Payload["use_ssl"].(bool)
			maxPwdAge := 90
			if v, ok := cmd.Payload["max_pwd_age_days"].(float64); ok && v > 0 {
				maxPwdAge = int(v)
			}
			eventHours := 48
			if v, ok := cmd.Payload["event_hours"].(float64); ok && v > 0 {
				eventHours = int(v)
			}
			log.Printf("Command received: ad_sync — dc=%s base=%s", dcHost, baseDN)
			adSyncCfg := collector.ADConfig{
				DCHost: dcHost, BaseDN: baseDN,
				Username: username, Password: password,
				UseSSL: useSSL, MaxPwdAge: maxPwdAge,
			}
			safeGo("ad_sync", func() { runADSync(rep, adSyncCfg, eventHours) })
		case "ad_user_action":
			dcHost, _ := cmd.Payload["dc_host"].(string)
			baseDN, _ := cmd.Payload["base_dn"].(string)
			username, _ := cmd.Payload["username"].(string)
			password, _ := cmd.Payload["password"].(string)
			action, _ := cmd.Payload["action"].(string)
			sam, _ := cmd.Payload["sam_account_name"].(string)
			actionID, _ := cmd.Payload["action_id"].(string)
			newPwd, _ := cmd.Payload["new_password"].(string)
			useSSL, _ := cmd.Payload["use_ssl"].(bool)
			adCfg := collector.ADConfig{
				DCHost: dcHost, BaseDN: baseDN,
				Username: username, Password: password,
				UseSSL: useSSL, NewPassword: newPwd,
			}
			// Bulk: sam_account_names is a list of {sam, action_id} pairs
			if bulkRaw, ok := cmd.Payload["sam_account_names"]; ok {
				if bulkList, ok := bulkRaw.([]interface{}); ok {
					log.Printf("Command received: ad_user_action bulk — action=%s count=%d", action, len(bulkList))
					safeGo("ad_user_action_bulk", func() {
						for _, item := range bulkList {
							if m, ok := item.(map[string]interface{}); ok {
								s, _ := m["sam"].(string)
								aid, _ := m["action_id"].(string)
								runADUserAction(rep, adCfg, action, s, aid)
							}
						}
					})
					break
				}
			}
			log.Printf("Command received: ad_user_action — action=%s user=%s", action, sam)
			adActCfg := collector.ADConfig{
				DCHost: dcHost, BaseDN: baseDN,
				Username: username, Password: password,
				UseSSL: useSSL, NewPassword: newPwd,
			}
			safeGo("ad_user_action", func() { runADUserAction(rep, adActCfg, action, sam, actionID) })
		case "ad_test":
			commandID, _ := cmd.Payload["command_id"].(string)
			dcHost, _ := cmd.Payload["dc_host"].(string)
			baseDN, _ := cmd.Payload["base_dn"].(string)
			username, _ := cmd.Payload["username"].(string)
			password, _ := cmd.Payload["password"].(string)
			useSSL, _ := cmd.Payload["use_ssl"].(bool)
			log.Printf("Command received: ad_test — dc=%s", dcHost)
			adTestCfg := collector.ADConfig{
				DCHost: dcHost, BaseDN: baseDN,
				Username: username, Password: password,
				UseSSL: useSSL,
			}
			safeGo("ad_test", func() { runADTest(rep, adTestCfg, commandID) })

		case "db_check":
			monitorID, _ := cmd.Payload["monitor_id"].(string)
			dbType, _ := cmd.Payload["db_type"].(string)
			host, _ := cmd.Payload["host"].(string)
			username, _ := cmd.Payload["username"].(string)
			password, _ := cmd.Payload["password"].(string)
			database, _ := cmd.Payload["database"].(string)
			port := 0
			if p, ok := cmd.Payload["port"].(float64); ok {
				port = int(p)
			}
			timeoutSecs := 10
			if t, ok := cmd.Payload["timeout_seconds"].(float64); ok && t > 0 {
				timeoutSecs = int(t)
			}
			log.Printf("Command received: db_check — monitor=%s type=%s host=%s:%d", monitorID, dbType, host, port)
			safeGo("db_check", func() { runDBCheck(rep, monitorID, dbType, host, port, username, password, database, timeoutSecs) })
		case "service_control":
			svcName, _ := cmd.Payload["service_name"].(string)
			action, _ := cmd.Payload["action"].(string)
			if svcName != "" && action != "" {
				log.Printf("Command received: service_control — service=%s action=%s", svcName, action)
				safeGo("service_control", func() { runServiceControl(rep, svcName, action) })
			}

		case "software_uninstall":
			swName, _ := cmd.Payload["name"].(string)
			swVersion, _ := cmd.Payload["version"].(string)
			swJobID, _ := cmd.Payload["uninstall_job_id"].(string)
			if swName != "" {
				log.Printf("Command received: software_uninstall — name=%s version=%s job=%s", swName, swVersion, swJobID)
				safeGo("software_uninstall", func() { runSoftwareUninstall(rep, swName, swVersion, swJobID) })
			}

		case "collect_inventory":
			log.Printf("Command received: collect_inventory")
			safeGo("collect_inventory", func() { sendInventory(rep) })

		case "software_install":
			jobID, _ := cmd.Payload["deploy_job_id"].(string)
			swName, _ := cmd.Payload["name"].(string)
			dlURL, _ := cmd.Payload["url"].(string)
			installArgs, _ := cmd.Payload["args"].(string)
			checksum, _ := cmd.Payload["checksum"].(string)
			installerType, _ := cmd.Payload["installer_type"].(string)
			if dlURL != "" {
				log.Printf("Command received: software_install — name=%s job=%s", swName, jobID)
				safeGo("software_install", func() { runSoftwareInstall(rep, jobID, swName, dlURL, installArgs, checksum, installerType) })
			}

		case "security_scan":
			log.Printf("Command received: security_scan")
			safeGo("security_scan", func() { runSecurityScan(rep) })

		case "web_config_check":
			log.Printf("Command received: web_config_check")
			safeGo("web_config_check", func() { runWebConfigCheck(rep) })

		default:
			log.Printf("Unknown command type: %s", cmd.Type)
		}
	}
}

func runPatchScan(rep *reporter.Reporter) {
	patches, err := collector.CollectPendingUpdates()
	if err != nil {
		log.Printf("Patch scan error: %v", err)
		return
	}
	log.Printf("Patch scan complete — %d pending update(s)", len(patches))
	if err := rep.SendPatchReport(patches); err != nil {
		log.Printf("Patch report upload error: %v", err)
	} else {
		log.Printf("Patch report sent successfully")
	}

	// Also send installed update history
	history := collector.CollectUpdateHistory()
	if len(history) > 0 {
		if err := rep.SendUpdateHistory(history); err != nil {
			log.Printf("Update history upload error: %v", err)
		} else {
			log.Printf("Update history sent — %d item(s)", len(history))
		}
	}
}

func runApplyPatches(rep *reporter.Reporter, jobID string, packages []string, rebootAfter bool, rebootMode string, rebootDelay int) {
	log.Printf("Applying %d package(s): %v", len(packages), packages)
	output, err := collector.ApplyPatches(packages)
	status := "success"
	if err != nil {
		status = "failed"
		log.Printf("Patch apply failed: %v", err)
		output += "\n[ERROR] " + err.Error()
	} else {
		log.Printf("Patch apply completed successfully")
	}
	if jobID != "" {
		if sendErr := rep.SendApplyResult(jobID, status, output); sendErr != nil {
			log.Printf("Failed to report apply result: %v", sendErr)
		}
	}
	// Re-scan so the UI shows updated patch list
	go runPatchScan(rep)
	// Reboot if requested and patching succeeded
	if status == "success" && rebootAfter {
		log.Printf("Reboot after patch: mode=%s delay=%ds", rebootMode, rebootDelay)
		// Notify server (and via email) that restart is imminent
		if notifyErr := rep.SendRestartNotice(jobID, "Maintenance Cycle", rebootDelay); notifyErr != nil {
			log.Printf("Failed to send restart notice: %v", notifyErr)
		}
		runRestartMachine(rebootMode, rebootDelay)
	}
}

func runSelfUpdate(rep *reporter.Reporter, downloadURL string) {
	log.Printf("Self-update: downloading from %s", downloadURL)
	if err := rep.SelfUpdate(downloadURL); err != nil {
		log.Printf("Self-update failed: %v", err)
	}
}

func runDBCheck(rep *reporter.Reporter, monitorID, dbType, host string, port int, username, password, database string, timeoutSecs int) {
	result := collector.RunDBCheck(dbType, host, port, username, password, database, timeoutSecs)
	log.Printf("DB check result: monitor=%s status=%s latency=%dms msg=%s", monitorID, result.Status, result.LatencyMs, result.Message)
	if err := rep.SendDBCheckResult(monitorID, result.Status, result.Message, result.LatencyMs); err != nil {
		log.Printf("Failed to send db-check-result: %v", err)
	}
}

func runRestartMachine(mode string, delaySecs int) {
	log.Printf("Restarting machine — mode=%s delay=%ds", mode, delaySecs)
	if err := collector.RestartMachine(mode, delaySecs); err != nil {
		log.Printf("Restart failed: %v", err)
	}
}

func runADTest(rep *reporter.Reporter, cfg collector.ADConfig, commandID string) {
	result := collector.RunADTest(cfg, commandID)
	log.Printf("AD test: success=%v msg=%s latency=%dms", result.Success, result.Message, result.LatencyMs)
	if err := rep.SendADTestResult(result); err != nil {
		log.Printf("Failed to send AD test result: %v", err)
	}
}

func runADSync(rep *reporter.Reporter, cfg collector.ADConfig, eventHours int) {
	result := collector.RunADSync(cfg)
	log.Printf("AD sync complete — %d users, %d groups, err: %s", len(result.Users), len(result.Groups), result.Error)
	if err := rep.SendADSyncResult(rep.AgentID(), result); err != nil {
		log.Printf("Failed to send AD sync result: %v", err)
	}
	events := collector.ReadADEvents(eventHours)
	log.Printf("AD events read: %d", len(events))
	if len(events) > 0 {
		if err := rep.SendADEventsResult(events); err != nil {
			log.Printf("Failed to send AD events: %v", err)
		}
	}
}

func runADUserAction(rep *reporter.Reporter, cfg collector.ADConfig, action, sam, actionID string) {
	result := collector.RunADUserAction(cfg, action, sam, actionID)
	log.Printf("AD user action: action=%s user=%s success=%v", action, sam, result.Success)
	if err := rep.SendADActionResult(result); err != nil {
		log.Printf("Failed to send AD action result: %v", err)
	}
}

func runServiceControl(rep *reporter.Reporter, svcName, action string) {
	result := collector.ControlService(svcName, action)
	log.Printf("Service control: %s %s — success=%v status=%s", action, svcName, result.Success, result.NewStatus)
	if err := rep.SendServiceControlResult(result); err != nil {
		log.Printf("Failed to send service-control-result: %v", err)
	}
}

func runSoftwareUninstall(rep *reporter.Reporter, name, version, jobID string) {
	result := collector.UninstallSoftware(name, version, jobID)
	log.Printf("Software uninstall: %s job=%s — success=%v", name, jobID, result.Success)
	if err := rep.SendUninstallResult(result); err != nil {
		log.Printf("Failed to send uninstall result: %v", err)
	}
	if result.Success {
		go sendInventory(rep)
	}
}

func runSoftwareInstall(rep *reporter.Reporter, jobID, name, url, args, checksum, installerType string) {
	result := collector.InstallSoftware(jobID, name, url, args, checksum, installerType)
	log.Printf("Software install: %s job=%s — success=%v", name, jobID, result.Success)
	if err := rep.SendInstallResult(result); err != nil {
		log.Printf("Failed to send install result: %v", err)
	}
	if result.Success {
		go sendInventory(rep)
	}
}

func sendInventory(rep *reporter.Reporter) {
	hw, err := collector.CollectHardware()
	if err != nil {
		log.Printf("Hardware collection error: %v", err)
		hw = nil
	}

	sw := collector.CollectSoftware()
	log.Printf("Sending inventory — %d software items", len(sw))

	if err := rep.SendInventory(hw, sw); err != nil {
		log.Printf("Inventory upload error: %v", err)
	} else {
		log.Printf("Inventory uploaded successfully")
	}

	// Send security + web config + license + RDP session reports alongside inventory
	go runSecurityScan(rep)
	go runWebConfigCheck(rep)
	go runLicenseScan(rep)
	go runRDPSessionsReport(rep)
}

func runRDPSessionsReport(rep *reporter.Reporter) {
	sessions := collector.CollectRDPSessions(168) // 7 days — captures long-running sessions
	if len(sessions) == 0 {
		return
	}
	log.Printf("RDP sessions collected: %d", len(sessions))
	if err := rep.SendRDPSessions(sessions); err != nil {
		log.Printf("RDP sessions upload error: %v", err)
	} else {
		log.Printf("RDP sessions sent — %d session(s)", len(sessions))
	}
}

func runLicenseScan(rep *reporter.Reporter) {
	licenses := collector.CollectLicenses()
	if len(licenses) == 0 {
		return
	}
	log.Printf("License scan complete — %d license(s)", len(licenses))
	if err := rep.SendLicenseReport(licenses); err != nil {
		log.Printf("License report upload error: %v", err)
	} else {
		log.Printf("License report sent successfully")
	}
}

func runSecurityScan(rep *reporter.Reporter) {
	report := collector.SecurityReport{
		Security:  collector.CollectSecurityState(),
		OpenPorts: collector.CollectOpenPorts(),
	}
	log.Printf("Security scan complete — %d open ports", len(report.OpenPorts))
	if err := rep.SendSecurityReport(report); err != nil {
		log.Printf("Security report upload error: %v", err)
	} else {
		log.Printf("Security report sent successfully")
	}
}

func runWebConfigCheck(rep *reporter.Reporter) {
	findings := collector.CollectWebConfig()
	log.Printf("Web config check complete — %d finding(s)", len(findings))
	if err := rep.SendWebConfigReport(findings); err != nil {
		log.Printf("Web config report upload error: %v", err)
	} else {
		log.Printf("Web config report sent successfully")
	}
}
