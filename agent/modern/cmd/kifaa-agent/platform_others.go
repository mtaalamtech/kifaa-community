//go:build !windows

package main

import "kifaa-agent/internal/config"

func runAgentPlatform(cfg *config.Config) {
	runAgent(cfg, nil)
}
