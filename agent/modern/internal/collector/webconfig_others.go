//go:build !linux && !windows

package collector

// CollectWebConfig returns nil on unsupported platforms.
func CollectWebConfig() []WebConfigFinding {
	return nil
}
