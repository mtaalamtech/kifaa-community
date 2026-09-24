package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const AgentVersion = "1.4.4"

type Config struct {
	ServerURL           string `json:"server_url"`
	AgentID             string `json:"agent_id"`
	APIKey              string `json:"api_key"`
	RegistrationSecret  string `json:"registration_secret"`
	HeartbeatInterval   int    `json:"heartbeat_interval_seconds"`
	InventoryInterval   int    `json:"inventory_interval_seconds"`
	InsecureSkipVerify  bool   `json:"insecure_skip_verify"`
}

func DefaultConfig() *Config {
	return &Config{
		ServerURL:          "http://kifaa.kenyanut.com",
		HeartbeatInterval:  30,
		InventoryInterval:  3600,
		InsecureSkipVerify: false,
	}
}

func ConfigPath() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "KifaaAgent", "config.json")
	default:
		return "/etc/kifaa-agent/config.json"
	}
}

func Load() (*Config, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config not found at %s: %w", path, err)
	}
	cfg := DefaultConfig()
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	return cfg, nil
}

func Save(cfg *Config) error {
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
