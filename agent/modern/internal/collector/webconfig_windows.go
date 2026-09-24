//go:build windows

package collector

import (
	"os"
	"path/filepath"
	"strings"
)

// CollectWebConfig checks IIS configuration on Windows.
func CollectWebConfig() []WebConfigFinding {
	var findings []WebConfigFinding

	// IIS applicationHost.config locations
	iisConfigs := []string{
		filepath.Join(os.Getenv("windir"), `System32\inetsrv\config\applicationHost.config`),
		filepath.Join(os.Getenv("windir"), `SysWOW64\inetsrv\config\applicationHost.config`),
	}

	for _, path := range iisConfigs {
		if _, err := os.Stat(path); err == nil {
			findings = append(findings, checkIISConfig(path)...)
		}
	}

	return findings
}

// checkIISConfig inspects an IIS applicationHost.config for security issues.
func checkIISConfig(path string) []WebConfigFinding {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(data)
	lower := strings.ToLower(content)
	var findings []WebConfigFinding

	// Directory browsing enabled
	if strings.Contains(lower, `directorybrowse enabled="true"`) {
		findings = append(findings, WebConfigFinding{
			ServerType:  "iis",
			ConfigFile:  path,
			FindingID:   "IIS_DIRECTORY_BROWSING",
			Severity:    "high",
			Title:       "IIS directory browsing is enabled",
			Detail:      "Directory browsing exposes file/directory listings to clients.",
			Remediation: "Disable in IIS Manager: Sites → [site] → Directory Browsing → Disable. Or set enabled=\"false\" in applicationHost.config.",
		})
	}

	// Detailed errors exposed to remote clients
	if strings.Contains(lower, `errormode="detailederrors"`) {
		findings = append(findings, WebConfigFinding{
			ServerType:  "iis",
			ConfigFile:  path,
			FindingID:   "IIS_DETAILED_ERRORS",
			Severity:    "medium",
			Title:       "IIS detailed error messages are enabled",
			Detail:      "Detailed errors can expose stack traces and internal paths.",
			Remediation: "Set errorMode to 'DetailedLocalOnly' or 'Custom' in applicationHost.config.",
		})
	}

	// No HSTS
	if strings.Contains(lower, "https") && !strings.Contains(lower, "strict-transport-security") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "iis",
			ConfigFile:  path,
			FindingID:   "IIS_NO_HSTS",
			Severity:    "medium",
			Title:       "HSTS header not configured on IIS HTTPS site",
			Remediation: "Add HSTS header via web.config: <add name=\"Strict-Transport-Security\" value=\"max-age=31536000\" />",
		})
	}

	// TLS — check for old protocol bindings
	if strings.Contains(lower, "ssl2") || strings.Contains(lower, "ssl3") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "iis",
			ConfigFile:  path,
			FindingID:   "IIS_WEAK_TLS",
			Severity:    "high",
			Title:       "IIS references old SSL/TLS protocol versions",
			Remediation: "Disable SSLv2/SSLv3 via registry: HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols",
		})
	}

	return findings
}
