//go:build linux

package collector

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type SoftwareItem struct {
	Name        string  `json:"name"`
	Version     string  `json:"version,omitempty"`
	Publisher   string  `json:"publisher,omitempty"`
	InstallDate string  `json:"install_date,omitempty"`
	SizeMB      float64 `json:"size_mb,omitempty"`
}

func CollectSoftware() []SoftwareItem {
	var items []SoftwareItem

	// Try dpkg (Debian/Ubuntu)
	cmd := exec.Command("dpkg-query", "-W", "-f=${Package}\t${Version}\t${Installed-Size}\t${Maintainer}\n")
	out, err := cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := scanner.Text()
			parts := strings.Split(line, "\t")
			if len(parts) < 2 {
				continue
			}
			item := SoftwareItem{
				Name:    parts[0],
				Version: parts[1],
			}
			if len(parts) >= 3 && parts[2] != "" {
				var sizeKB float64
				if _, err := fmt.Sscanf(parts[2], "%f", &sizeKB); err == nil {
					item.SizeMB = sizeKB / 1024
				}
			}
			if len(parts) >= 4 {
				item.Publisher = parts[3]
			}
			items = append(items, item)
		}
		items = append(items, detectSAPSoftware()...)
		return items
	}

	// Try rpm (RHEL/CentOS/SUSE)
	cmd = exec.Command("rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n")
	out, err = cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := scanner.Text()
			parts := strings.Split(line, "\t")
			if len(parts) < 1 {
				continue
			}
			item := SoftwareItem{Name: parts[0]}
			if len(parts) >= 2 {
				item.Version = parts[1]
			}
			if len(parts) >= 3 {
				item.Publisher = parts[2]
			}
			items = append(items, item)
		}
	}

	// Append SAP/HANA software detected from filesystem
	items = append(items, detectSAPSoftware()...)
	return items
}

// detectSAPSoftware scans for SAP HANA and SAP application installations that
// are not captured by package managers (rpm/dpkg). Looks under /usr/sap and /hana.
func detectSAPSoftware() []SoftwareItem {
	var items []SoftwareItem

	// ── SAP HANA ────────────────────────────────────────────────────────────
	// HANA instances live at /hana/shared/<SID>/HDB<instance>/
	hanaSharedDirs, _ := filepath.Glob("/hana/shared/*/HDB*")
	for _, dir := range hanaSharedDirs {
		// Try to read version from the exe directory
		version := ""
		for _, verFile := range []string{
			filepath.Join(dir, "exe", "version.txt"),
			filepath.Join(dir, "global", "hdb", "HDB_REVISION_VERSION.TXT"),
		} {
			data, err := os.ReadFile(verFile)
			if err == nil {
				for _, line := range strings.Split(string(data), "\n") {
					line = strings.TrimSpace(line)
					if strings.HasPrefix(strings.ToUpper(line), "VERSION:") ||
						strings.HasPrefix(strings.ToUpper(line), "BRANCH:") {
						continue
					}
					// Typical format: "2.00.076.00.1723040594"
					if len(line) > 4 && !strings.Contains(line, ":") && !strings.Contains(line, "=") {
						version = line
						break
					}
				}
				if version != "" {
					break
				}
			}
		}
		// Extract SID from path /hana/shared/<SID>/HDB<instance>
		parts := strings.Split(filepath.ToSlash(dir), "/")
		sid := ""
		if len(parts) >= 4 {
			sid = parts[3]
		}
		name := "SAP HANA"
		if sid != "" {
			name = "SAP HANA (SID: " + sid + ")"
		}
		items = append(items, SoftwareItem{
			Name:      name,
			Version:   version,
			Publisher: "SAP SE",
		})
	}

	// ── SAP Applications under /usr/sap ──────────────────────────────────────
	// Detect SAP Business One, SAP NetWeaver, SAP Router, etc.
	if entries, err := os.ReadDir("/usr/sap"); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			appDir := filepath.Join("/usr/sap", entry.Name())
			name, version := detectSAPApp(entry.Name(), appDir)
			if name != "" {
				items = append(items, SoftwareItem{
					Name:      name,
					Version:   version,
					Publisher: "SAP SE",
				})
			}
		}
	}

	return items
}

// detectSAPApp identifies a SAP application under /usr/sap/<name>
// and returns a human-friendly name + version string.
func detectSAPApp(dirName, appDir string) (string, string) {
	upper := strings.ToUpper(dirName)

	switch {
	case upper == "SAPBUSINESSONE" || strings.Contains(upper, "B1") || strings.Contains(dirName, "SAPBusiness"):
		version := readSAPB1Version(appDir)
		return "SAP Business One", version

	case strings.HasPrefix(upper, "HDB") || strings.HasPrefix(upper, "NDB"):
		// This is a HANA SID — already captured above
		return "", ""

	case upper == "SAPROUTER" || upper == "SLDAGENT" || upper == "SLDREG":
		return "SAP Router / SLD Agent", ""

	case upper == "HOSTCTRL" || upper == "SAPHostControl":
		return "SAP Host Agent", ""

	default:
		// Generic SAP SID (e.g. ERP, CRM, BW) — look for instance profile
		profileDir := filepath.Join(appDir, "SYS", "profile")
		if _, err := os.Stat(profileDir); err == nil {
			return "SAP Application (" + dirName + ")", ""
		}
	}
	return "", ""
}

func readSAPB1Version(appDir string) string {
	// SAP Business One version typically in ServerComponents/version.xml or similar
	for _, candidate := range []string{
		filepath.Join(appDir, "ServerComponents", "version.xml"),
		filepath.Join(appDir, "setup", "version.xml"),
		filepath.Join(appDir, "B1SiteService", "version.xml"),
	} {
		data, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		// Look for <Version>...</Version> or ProductVersion
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			for _, tag := range []string{"<Version>", "<ProductVersion>", "<FileVersion>"} {
				if idx := strings.Index(line, tag); idx >= 0 {
					start := idx + len(tag)
					end := strings.Index(line[start:], "<")
					if end > 0 {
						return strings.TrimSpace(line[start : start+end])
					}
				}
			}
		}
	}
	// Try reading from common B1 release note file
	files, _ := filepath.Glob(filepath.Join(appDir, "*.release"))
	if len(files) > 0 {
		data, err := os.ReadFile(files[0])
		if err == nil {
			return strings.TrimSpace(strings.Split(string(data), "\n")[0])
		}
	}
	return ""
}
