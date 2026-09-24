package reporter

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"kifaa-agent/internal/collector"
	"kifaa-agent/internal/config"
)

type Reporter struct {
	cfg    *config.Config
	client *http.Client
}

type RegisterRequest struct {
	RegistrationSecret string `json:"registration_secret"`
	Hostname           string `json:"hostname"`
	IPAddress          string `json:"ip_address"`
	MACAddress         string `json:"mac_address"`
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
	Message string `json:"message"`
}

type HeartbeatRequest struct {
	Timestamp      time.Time                `json:"timestamp"`
	Metrics        []collector.MetricPoint  `json:"metrics"`
	Services       []collector.ServiceInfo  `json:"services"`
	IPAddress      string                   `json:"ip_address"`
	AgentVersion   string                   `json:"agent_version"`
	RestartPending bool                     `json:"restart_pending"`
	OSName         string                   `json:"os_name,omitempty"`
	OSVersion      string                   `json:"os_version,omitempty"`
	Hostname       string                   `json:"hostname,omitempty"`
}

type PendingCommand struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

type HeartbeatResponse struct {
	Status          string           `json:"status"`
	ServerTime      time.Time        `json:"server_time"`
	PendingCommands []PendingCommand `json:"pending_commands"`
}

type PatchReportRequest struct {
	Patches []collector.PatchInfo `json:"patches"`
}

type InventoryRequest struct {
	Hardware *collector.HardwareData  `json:"hardware,omitempty"`
	Software []collector.SoftwareItem `json:"software,omitempty"`
}

func (r *Reporter) AgentID() string {
	return r.cfg.AgentID
}

func New(cfg *config.Config) *Reporter {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.InsecureSkipVerify,
		},
	}
	return &Reporter{
		cfg: cfg,
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
	}
}

func (r *Reporter) post(path string, body interface{}, apiKey string) ([]byte, int, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}

	url := r.cfg.ServerURL + "/api/v1" + path
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
}

func (r *Reporter) Register(sysInfo *collector.SystemInfo) (*RegisterResponse, error) {
	req := RegisterRequest{
		RegistrationSecret: r.cfg.RegistrationSecret,
		Hostname:           sysInfo.Hostname,
		IPAddress:          sysInfo.IPAddress,
		MACAddress:         sysInfo.MACAddress,
		OSType:             sysInfo.OSType,
		OSName:             sysInfo.OSName,
		OSVersion:          sysInfo.OSVersion,
		OSArch:             sysInfo.OSArch,
		AgentVersion:       config.AgentVersion,
		AgentType:          "modern",
	}

	body, status, err := r.post("/agents/register", req, "")
	if err != nil {
		return nil, fmt.Errorf("register request failed: %w", err)
	}
	if status != 201 && status != 200 {
		return nil, fmt.Errorf("registration failed (HTTP %d): %s", status, string(body))
	}

	var resp RegisterResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse register response: %w", err)
	}
	return &resp, nil
}

func (r *Reporter) SendHeartbeat(metrics []collector.MetricPoint, services []collector.ServiceInfo, ipAddr string, restartPending bool, sysInfo *collector.SystemInfo) (*HeartbeatResponse, error) {
	req := HeartbeatRequest{
		Timestamp:      time.Now().UTC(),
		Metrics:        metrics,
		Services:       services,
		IPAddress:      ipAddr,
		AgentVersion:   config.AgentVersion,
		RestartPending: restartPending,
	}
	if sysInfo != nil {
		req.OSName = sysInfo.OSName
		req.OSVersion = sysInfo.OSVersion
		req.Hostname = sysInfo.Hostname
	}
	body, status, err := r.post("/agents/heartbeat", req, r.cfg.APIKey)
	if err != nil {
		return nil, fmt.Errorf("heartbeat failed: %w", err)
	}
	if status != 200 {
		return nil, fmt.Errorf("heartbeat rejected (HTTP %d)", status)
	}
	var resp HeartbeatResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return &HeartbeatResponse{}, nil // non-fatal parse error
	}
	return &resp, nil
}

func (r *Reporter) SendPatchReport(patches []collector.PatchInfo) error {
	req := PatchReportRequest{Patches: patches}
	_, status, err := r.post("/agents/patch-report", req, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("patch report failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("patch report rejected (HTTP %d)", status)
	}
	return nil
}

// SendUpdateHistory reports installed update history to the server.
func (r *Reporter) SendUpdateHistory(items []collector.UpdateHistoryItem) error {
	if len(items) == 0 {
		return nil
	}
	type payload struct {
		History []collector.UpdateHistoryItem `json:"history"`
	}
	_, status, err := r.post("/patches/update-history", payload{History: items}, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("update history upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("update history rejected (HTTP %d)", status)
	}
	return nil
}

// SelfUpdate downloads a new binary and triggers a self-replace + service restart.
// The actual file-swap is done by a platform-specific helper (see selfupdate_*.go).
func (r *Reporter) SelfUpdate(downloadURL string) error {
	resp, err := r.client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	return applyUpdate(data)
}

type ApplyResultRequest struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"` // "success" or "failed"
	Output string `json:"output"`
}

// SendApplyResult reports the outcome of an agent-side patch apply back to the server.
func (r *Reporter) SendApplyResult(jobID, status, output string) error {
	req := ApplyResultRequest{JobID: jobID, Status: status, Output: output}
	_, code, err := r.post("/agents/patch-apply-result", req, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send apply result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("apply result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendDBCheckResult(monitorID, status, message string, latencyMs int) error {
	req := map[string]interface{}{
		"monitor_id": monitorID,
		"status":     status,
		"latency_ms": latencyMs,
		"message":    message,
	}
	_, code, err := r.post("/agents/db-check-result", req, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send db-check-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("db-check-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendADSyncResult(agentID string, result collector.ADSyncResult) error {
	body := map[string]interface{}{
		"agent_id": agentID,
		"result":   result,
	}
	_, code, err := r.post("/agents/ad-sync-result", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send ad-sync-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("ad-sync-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendADEventsResult(events []collector.ADEvent) error {
	body := map[string]interface{}{"events": events}
	_, code, err := r.post("/agents/ad-events-result", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send ad-events-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("ad-events-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendADTestResult(result collector.ADTestResult) error {
	_, code, err := r.post("/agents/ad-test-result", result, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send ad-test-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("ad-test-result rejected (HTTP %d)", code)
	}
	return nil
}

// PollCommands fetches pending commands without sending metrics.
// Used by the 5-second fast-poll goroutine for near-immediate command delivery.
func (r *Reporter) PollCommands() ([]PendingCommand, error) {
	url := r.cfg.ServerURL + "/api/v1/agents/commands"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", r.cfg.APIKey)

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, nil
	}

	body, _ := io.ReadAll(resp.Body)
	var result struct {
		Commands []PendingCommand `json:"commands"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result.Commands, nil
}

func (r *Reporter) SendADActionResult(result collector.ADActionResult) error {
	_, code, err := r.post("/agents/ad-action-result", result, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send ad-action-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("ad-action-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendServiceControlResult(result collector.ServiceControlResult) error {
	_, code, err := r.post("/agents/service-control-result", result, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send service-control-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("service-control-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendUninstallResult(result collector.UninstallResult) error {
	_, code, err := r.post("/agents/software-uninstall-result", result, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send uninstall-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("uninstall-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendInstallResult(result collector.InstallResult) error {
	_, code, err := r.post("/agents/software-install-result", result, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("send install-result: %w", err)
	}
	if code != 200 {
		return fmt.Errorf("install-result rejected (HTTP %d)", code)
	}
	return nil
}

func (r *Reporter) SendInventory(hw *collector.HardwareData, sw []collector.SoftwareItem) error {
	req := InventoryRequest{
		Hardware: hw,
		Software: sw,
	}
	_, status, err := r.post("/agents/inventory", req, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("inventory upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("inventory rejected (HTTP %d)", status)
	}
	return nil
}

// SendSecurityReport sends the security state and open ports to the server.
func (r *Reporter) SendSecurityReport(report collector.SecurityReport) error {
	_, status, err := r.post("/threats/security-report", report, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("security report upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("security report rejected (HTTP %d)", status)
	}
	return nil
}

// SendLicenseReport sends license information to the server.
func (r *Reporter) SendLicenseReport(licenses []collector.LicenseInfo) error {
	body := map[string]interface{}{"licenses": licenses}
	_, status, err := r.post("/licenses/report", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("license report upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("license report rejected (HTTP %d)", status)
	}
	return nil
}

// SendWebConfigReport sends web server misconfiguration findings to the server.
func (r *Reporter) SendWebConfigReport(findings []collector.WebConfigFinding) error {
	body := map[string]interface{}{"findings": findings}
	_, status, err := r.post("/threats/webconfig-report", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("web config report upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("web config report rejected (HTTP %d)", status)
	}
	return nil
}

// SendRDPSessions sends collected RDP session data to the server.
func (r *Reporter) SendRDPSessions(sessions []collector.RDPSession) error {
	body := map[string]interface{}{"sessions": sessions}
	_, status, err := r.post("/agents/rdp-sessions", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("RDP sessions upload failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("RDP sessions rejected (HTTP %d)", status)
	}
	return nil
}

// SendRestartNotice notifies the server that this agent is about to restart.
func (r *Reporter) SendRestartNotice(jobID, cycleName string, delaySecs int) error {
	body := map[string]interface{}{
		"job_id":         jobID,
		"delay_seconds":  delaySecs,
		"cycle_name":     cycleName,
	}
	_, status, err := r.post("/restart-notice", body, r.cfg.APIKey)
	if err != nil {
		return fmt.Errorf("restart notice failed: %w", err)
	}
	if status != 200 {
		return fmt.Errorf("restart notice rejected (HTTP %d)", status)
	}
	return nil
}
