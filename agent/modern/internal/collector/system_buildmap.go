package collector

import "strings"

// windowsBuildToName maps a Windows build version string to a friendly OS name.
// This is used as a fallback when WMI is unavailable.
func windowsBuildToName(version string) string {
	// Extract major.minor.build (ignore patch level after the third dot)
	parts := strings.SplitN(version, ".", 4)
	if len(parts) < 3 {
		return ""
	}
	build := parts[0] + "." + parts[1] + "." + parts[2]

	// Windows NT build → friendly name mapping
	// Server editions take priority over client editions for shared builds.
	buildMap := map[string]string{
		// Windows Server
		"10.0.20348": "Windows Server 2022",
		"10.0.19042": "Windows Server 2019 / Windows 10 20H2",
		"10.0.17763": "Windows Server 2019",
		"10.0.17134": "Windows Server 2019 / Windows 10 1803",
		"10.0.14393": "Windows Server 2016",
		"6.3.9600":   "Windows Server 2012 R2 / Windows 8.1",
		"6.2.9200":   "Windows Server 2012",
		"6.1.7601":   "Windows Server 2008 R2 SP1",
		"6.0.6002":   "Windows Server 2008 SP2",
		// Windows 11
		"10.0.26100": "Windows 11 24H2",
		"10.0.22631": "Windows 11 23H2",
		"10.0.22621": "Windows 11 22H2",
		"10.0.22000": "Windows 11 21H2",
		// Windows 10 (build numbers not already covered by Server entries)
		"10.0.19045": "Windows 10 22H2",
		"10.0.19044": "Windows 10 21H2",
		"10.0.19043": "Windows 10 21H1",
		"10.0.19041": "Windows 10 2004",
		"10.0.18363": "Windows 10 1909",
		"10.0.18362": "Windows 10 1903",
		"10.0.16299": "Windows 10 1709",
		"10.0.15063": "Windows 10 1703",
		"10.0.10586": "Windows 10 1511",
		"10.0.10240": "Windows 10 1507",
		"6.1.7600": "Windows 7",
	}

	if name, ok := buildMap[build]; ok {
		return name
	}
	return ""
}
