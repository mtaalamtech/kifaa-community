//go:build windows

package collector

import (
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// windowsFriendlyName returns the proper marketing name for Windows.
// Tries PowerShell WMI first, then registry (no PowerShell needed),
// then falls back to build-number mapping.
func windowsFriendlyName(platform, family, version string) string {
	// Try WMI caption first — most accurate and includes edition
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-Command", "(Get-WmiObject Win32_OperatingSystem).Caption").Output()
	if err == nil {
		caption := strings.TrimSpace(string(out))
		if caption != "" {
			return cleanWindowsCaption(caption)
		}
	}

	// Fallback: registry ProductName — works without PowerShell, returns
	// full name including edition, e.g. "Windows Server 2019 Standard"
	regName := getOSNameFromRegistry()
	if regName != "" {
		return strings.TrimSpace(strings.TrimPrefix(regName, "Microsoft "))
	}

	// Last resort: map major.minor.build to marketing name
	return windowsBuildToName(version)
}

// linuxFriendlyName is a no-op stub on Windows.
func linuxFriendlyName(platform, version string) string { return "" }

// GetDNSServers returns DNS servers on Windows via ipconfig.
func GetDNSServers() []string {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-Command", "(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses | Select-Object -Unique").Output()
	if err != nil {
		return nil
	}
	var servers []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			servers = append(servers, line)
		}
	}
	return servers
}

// GetDefaultGateway returns the default gateway on Windows.
func GetDefaultGateway() string {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-Command", "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// getOSNameFromRegistry reads HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProductName
// which is available on all Windows versions and does not require PowerShell.
func getOSNameFromRegistry() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`,
		registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	val, _, err := k.GetStringValue("ProductName")
	if err != nil {
		return ""
	}
	return val
}

// cleanWindowsCaption normalises a raw WMI caption into a friendly name,
// keeping edition information (Standard, Professional, etc.) visible.
// "Microsoft Windows Server 2019 Standard" → "Windows Server 2019 Standard"
// "Microsoft Windows 10 Pro"               → "Windows 10 Pro"
func cleanWindowsCaption(caption string) string {
	// Strip leading "Microsoft " only
	caption = strings.TrimPrefix(caption, "Microsoft ")
	return strings.TrimSpace(caption)
}
