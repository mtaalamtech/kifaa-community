//go:build !linux && !windows

package collector

// CollectSecurityState returns an empty SecurityState on unsupported platforms.
func CollectSecurityState() SecurityState {
	return SecurityState{}
}
