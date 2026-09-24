//go:build !linux && !windows

package collector

// CollectOpenPorts returns nil on unsupported platforms.
func CollectOpenPorts() []OpenPort {
	return nil
}
