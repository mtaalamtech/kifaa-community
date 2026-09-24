//go:build !linux && !windows

package collector

// CollectLicenses returns nil on unsupported platforms.
func CollectLicenses() []LicenseInfo {
	return nil
}
