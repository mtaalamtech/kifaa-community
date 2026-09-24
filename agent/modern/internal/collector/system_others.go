//go:build !windows

package collector

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// windowsFriendlyName is a no-op stub on non-Windows.
// The actual friendly name is built by linuxFriendlyName() called from GetSystemInfo.
func windowsFriendlyName(platform, family, version string) string {
	return ""
}

// linuxFriendlyName returns a human-readable OS name by reading /etc/os-release.
// Falls back to gopsutil platform+version string if the file is unavailable.
//
// Examples:
//   - "SUSE Linux Enterprise Server 12 SP4"
//   - "Ubuntu 22.04.3 LTS"
//   - "CentOS Linux 7 (Core)"
//   - "Red Hat Enterprise Linux 8.8 (Ootpa)"
func linuxFriendlyName(platform, version string) string {
	fields := parseOsRelease()
	if len(fields) == 0 {
		return fallbackLinuxName(platform, version)
	}

	// PRETTY_NAME is the most complete display string, e.g.
	// "SUSE Linux Enterprise Server 12 SP4" or "Ubuntu 22.04.3 LTS"
	if v := fields["PRETTY_NAME"]; v != "" {
		return v
	}

	// Build from NAME + VERSION
	name := fields["NAME"]
	ver := fields["VERSION"]
	if name != "" && ver != "" {
		return fmt.Sprintf("%s %s", name, ver)
	}
	if name != "" {
		return name
	}

	return fallbackLinuxName(platform, version)
}

func fallbackLinuxName(platform, version string) string {
	if platform == "" {
		return ""
	}
	// Capitalise known distro names
	p := strings.ToLower(platform)
	switch {
	case strings.Contains(p, "suse") || strings.Contains(p, "sles"):
		platform = strings.ReplaceAll(platform, "suse", "SUSE")
		platform = strings.ReplaceAll(platform, "SUSE linux", "SUSE Linux")
	case p == "ubuntu":
		platform = "Ubuntu"
	case p == "debian":
		platform = "Debian"
	case p == "centos":
		platform = "CentOS"
	case p == "rhel" || strings.Contains(p, "red hat"):
		platform = "Red Hat Enterprise Linux"
	case p == "fedora":
		platform = "Fedora"
	case p == "arch":
		platform = "Arch Linux"
	case p == "alpine":
		platform = "Alpine Linux"
	case p == "amazon":
		platform = "Amazon Linux"
	case p == "oracle":
		platform = "Oracle Linux"
	}
	if version == "" {
		return platform
	}
	return fmt.Sprintf("%s %s", platform, version)
}

// GetDNSServers reads DNS nameservers from /etc/resolv.conf on Linux/macOS.
func GetDNSServers() []string {
	f, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return nil
	}
	defer f.Close()
	var servers []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "nameserver") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				servers = append(servers, parts[1])
			}
		}
	}
	return servers
}

// GetDefaultGateway reads the default gateway from /proc/net/route on Linux.
func GetDefaultGateway() string {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	// Skip header
	scanner.Scan()
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		// Destination == 00000000 means default route
		if fields[1] == "00000000" {
			// Gateway is in little-endian hex
			gw := fields[2]
			if len(gw) == 8 {
				var b [4]byte
				for i := 0; i < 4; i++ {
					val := uint8(0)
					fmt.Sscanf(gw[i*2:i*2+2], "%02X", &val)
					b[3-i] = val
				}
				return fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
			}
		}
	}
	return ""
}

// parseOsRelease reads /etc/os-release and returns the key=value map.
// Values are unquoted.
func parseOsRelease() map[string]string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		// Try the fallback location
		f, err = os.Open("/usr/lib/os-release")
		if err != nil {
			return nil
		}
	}
	defer f.Close()

	fields := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		// Strip surrounding quotes
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		fields[key] = val
	}
	return fields
}
