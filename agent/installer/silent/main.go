//go:build windows

// kifaa-installer-silent — headless Windows installer for automated deployment.
// Usage: kifaa-installer-silent.exe --server https://kifaa.example.com --secret <registration_secret>
// Exit 0 on success, 1 on failure (for MSI custom action exit code checking).

package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var (
	agentVersion = "1.3.1"
)

type RegisterRequest struct {
	RegistrationSecret string `json:"registration_secret"`
	Hostname           string `json:"hostname"`
	OSType             string `json:"os_type"`
	OSName             string `json:"os_name"`
	OSVersion          string `json:"os_version"`
	OSArch             string `json:"os_arch"`
	AgentVersion       string `json:"agent_version"`
	AgentType          string `json:"agent_type"`
}

type RegisterResponse struct {
	AgentID string `json:"agent_id"`
	APIKey  string `json:"api_key"`
}

type AgentConfig struct {
	ServerURL          string `json:"server_url"`
	AgentID            string `json:"agent_id"`
	APIKey             string `json:"api_key"`
	RegistrationSecret string `json:"registration_secret"`
	HeartbeatInterval  int    `json:"heartbeat_interval_seconds"`
	InventoryInterval  int    `json:"inventory_interval_seconds"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify"`
}

func logf(format string, args ...interface{}) {
	fmt.Printf("[kifaa] "+format+"\n", args...)
}

func fatal(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[kifaa] ERROR: "+format+"\n", args...)
	os.Exit(1)
}

func svcRun(args ...string) error {
	out, err := exec.Command("sc.exe", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sc %s: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}

func svcExists(name string) bool {
	return exec.Command("sc.exe", "query", name).Run() == nil
}

func main() {
	serverURL := flag.String("server", "", "Kifaa server URL (required)")
	secret := flag.String("secret", "", "Registration secret (required)")
	insecure := flag.Bool("insecure", false, "Skip TLS certificate verification")
	flag.Parse()

	if *serverURL == "" || *secret == "" {
		fmt.Fprintln(os.Stderr, "Usage: kifaa-installer-silent.exe --server <url> --secret <secret>")
		os.Exit(1)
	}

	*serverURL = strings.TrimRight(*serverURL, "/")

	client := &http.Client{
		Timeout: 120 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: *insecure},
		},
	}

	// ── Step 1: Download agent binary ────────────────────────────────────────
	arch := runtime.GOARCH
	binaryName := fmt.Sprintf("kifaa-agent-windows-%s.exe", arch)
	downloadURL := fmt.Sprintf("%s/downloads/%s", *serverURL, binaryName)

	installDir := filepath.Join(os.Getenv("ProgramFiles"), "KifaaAgent")
	if strings.TrimSpace(installDir) == `\KifaaAgent` || installDir == "" {
		installDir = `C:\Program Files\KifaaAgent`
	}

	logf("[1/4] Downloading agent binary: %s", downloadURL)
	if err := os.MkdirAll(installDir, 0755); err != nil {
		fatal("Cannot create install directory: %v", err)
	}

	agentExe := filepath.Join(installDir, "kifaa-agent.exe")

	if svcExists("KifaaAgent") {
		logf("      Stopping existing KifaaAgent service for upgrade…")
		exec.Command("sc.exe", "stop", "KifaaAgent").Run()
		time.Sleep(3 * time.Second)
	}

	resp, err := client.Get(downloadURL)
	if err != nil {
		fatal("Download failed: %v", err)
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		fatal("Server returned HTTP %d for %s", resp.StatusCode, downloadURL)
	}
	f, err := os.Create(agentExe)
	if err != nil {
		resp.Body.Close()
		fatal("Cannot create %s: %v", agentExe, err)
	}
	io.Copy(f, resp.Body)
	resp.Body.Close()
	f.Close()
	logf("      Saved to: %s", agentExe)

	// ── Step 2: Register with server ─────────────────────────────────────────
	logf("[2/4] Registering with server…")
	hostname, _ := os.Hostname()

	regReq := RegisterRequest{
		RegistrationSecret: *secret,
		Hostname:           hostname,
		OSType:             "windows",
		OSName:             "Windows",
		OSVersion:          "",
		OSArch:             arch,
		AgentVersion:       agentVersion,
		AgentType:          "modern",
	}
	regJSON, _ := json.Marshal(regReq)

	regResp, err := client.Post(*serverURL+"/api/v1/agents/register",
		"application/json", strings.NewReader(string(regJSON)))
	if err != nil {
		fatal("Registration request failed: %v", err)
	}
	defer regResp.Body.Close()
	body, _ := io.ReadAll(regResp.Body)
	if regResp.StatusCode != 200 && regResp.StatusCode != 201 {
		fatal("Registration failed (HTTP %d): %s", regResp.StatusCode, string(body))
	}
	var reg RegisterResponse
	if err := json.Unmarshal(body, &reg); err != nil {
		fatal("Bad server response: %v", err)
	}
	logf("      Agent ID: %s", reg.AgentID)

	// ── Step 3: Write config ─────────────────────────────────────────────────
	logf("[3/4] Writing config…")
	configDir := filepath.Join(os.Getenv("ProgramData"), "KifaaAgent")
	os.MkdirAll(configDir, 0755)
	configPath := filepath.Join(configDir, "config.json")
	cfg := AgentConfig{
		ServerURL:          *serverURL,
		AgentID:            reg.AgentID,
		APIKey:             reg.APIKey,
		RegistrationSecret: *secret,
		HeartbeatInterval:  30,
		InventoryInterval:  3600,
		InsecureSkipVerify: *insecure,
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		fatal("Cannot write config: %v", err)
	}
	logf("      Config: %s", configPath)

	// ── Step 4: Install and start service ────────────────────────────────────
	logf("[4/4] Installing KifaaAgent service…")
	if svcExists("KifaaAgent") {
		exec.Command("sc.exe", "stop", "KifaaAgent").Run()
		time.Sleep(2 * time.Second)
		exec.Command("sc.exe", "delete", "KifaaAgent").Run()
		time.Sleep(2 * time.Second)
	}

	binPath := `"` + agentExe + `"`
	if err := svcRun("create", "KifaaAgent",
		"binPath=", binPath,
		"DisplayName=", "Kifaa Endpoint Agent",
		"start=", "auto",
		"type=", "own",
	); err != nil {
		fatal("Service create failed: %v", err)
	}
	exec.Command("sc.exe", "description", "KifaaAgent",
		"Kifaa endpoint monitoring and management agent").Run()
	exec.Command("sc.exe", "failure", "KifaaAgent",
		"reset=", "86400",
		"actions=", "restart/10000/restart/10000/restart/30000").Run()

	if err := svcRun("start", "KifaaAgent"); err != nil {
		fatal("Service start failed: %v", err)
	}

	time.Sleep(3 * time.Second)
	out, _ := exec.Command("sc.exe", "query", "KifaaAgent").CombinedOutput()
	if strings.Contains(string(out), "RUNNING") {
		logf("✓ KifaaAgent installed and running!")
		logf("  Dashboard: %s", *serverURL)
	} else {
		fatal("Service not running after start. Check Event Viewer.")
	}
}
