//go:build windows

package collector

import (
	"os/exec"
	"strings"
)

// CollectLicenses returns license information for Windows and installed software.
func CollectLicenses() []LicenseInfo {
	var licenses []LicenseInfo

	// Windows OS activation
	if li := windowsOSLicense(); li != nil {
		licenses = append(licenses, *li)
	}

	// Office license
	if li := windowsOfficeLicense(); li != nil {
		licenses = append(licenses, *li)
	}

	return licenses
}

// windowsOSLicense queries Windows activation status via WMI.
func windowsOSLicense() *LicenseInfo {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`$sl = Get-CimInstance -ClassName SoftwareLicensingProduct -Filter "Name LIKE 'Windows%' AND PartialProductKey IS NOT NULL" | Select-Object -First 1;`+
			`if ($sl) { Write-Output ($sl.Name + "|" + $sl.LicenseStatus + "|" + $sl.PartialProductKey + "|" + $sl.LicenseFamily) }`).Output()
	if err != nil {
		return nil
	}

	line := strings.TrimSpace(string(out))
	if line == "" {
		return nil
	}

	parts := strings.SplitN(line, "|", 4)
	li := &LicenseInfo{
		SoftwareName: "Windows Operating System",
		LicenseType:  "unknown",
	}

	if len(parts) >= 1 {
		li.SoftwareName = strings.TrimSpace(parts[0])
	}

	// LicenseStatus: 1=Licensed, 2=OOBGrace, 3=OOTGrace, 4=NonGenuineGrace, 5=Notification, 6=ExtendedGrace
	if len(parts) >= 2 {
		switch strings.TrimSpace(parts[1]) {
		case "1":
			li.ActivationStatus = "activated"
		case "2", "6":
			li.ActivationStatus = "grace_period"
		case "3", "4", "5":
			li.ActivationStatus = "not_activated"
		default:
			li.ActivationStatus = "unknown"
		}
	}

	if len(parts) >= 3 {
		li.PartialKey = strings.TrimSpace(parts[2])
	}

	if len(parts) >= 4 {
		family := strings.ToLower(strings.TrimSpace(parts[3]))
		switch {
		case strings.Contains(family, "volume"):
			li.LicenseType = "volume"
			li.LicenseChannel = "MAK/KMS"
		case strings.Contains(family, "retail"):
			li.LicenseType = "retail"
			li.LicenseChannel = "RETAIL"
		case strings.Contains(family, "oem"):
			li.LicenseType = "oem"
			li.LicenseChannel = "OEM"
		}
	}

	// Fallback: check slmgr /dli for more details (slower but more complete)
	if li.LicenseChannel == "" {
		if slOut, err2 := exec.Command("cscript", "//nologo",
			`C:\Windows\System32\slmgr.vbs`, "/dli").Output(); err2 == nil {
			slStr := strings.ToLower(string(slOut))
			if strings.Contains(slStr, "kms") {
				li.LicenseType = "volume"
				li.LicenseChannel = "KMS"
			} else if strings.Contains(slStr, "mak") {
				li.LicenseType = "volume"
				li.LicenseChannel = "MAK"
			}
		}
	}

	return li
}

// windowsOfficeLicense checks Microsoft Office activation status.
func windowsOfficeLicense() *LicenseInfo {
	// Try Office OSPP script (works for Office 2013–2021)
	osppPaths := []string{
		`C:\Program Files\Microsoft Office\Office16\ospp.vbs`,
		`C:\Program Files (x86)\Microsoft Office\Office16\ospp.vbs`,
		`C:\Program Files\Microsoft Office\Office15\ospp.vbs`,
		`C:\Program Files (x86)\Microsoft Office\Office15\ospp.vbs`,
	}

	for _, path := range osppPaths {
		out, err := exec.Command("cscript", "//nologo", path, "/dstatus").Output()
		if err != nil {
			continue
		}
		content := string(out)
		lower := strings.ToLower(content)

		li := &LicenseInfo{
			SoftwareName: "Microsoft Office",
			LicenseType:  "unknown",
		}

		if strings.Contains(lower, "licensed") {
			li.ActivationStatus = "activated"
		} else if strings.Contains(lower, "grace") {
			li.ActivationStatus = "grace_period"
		} else if strings.Contains(lower, "unlicensed") || strings.Contains(lower, "not activated") {
			li.ActivationStatus = "not_activated"
		} else {
			li.ActivationStatus = "unknown"
		}

		// Extract partial key
		for _, line := range strings.Split(content, "\n") {
			line = strings.TrimSpace(line)
			if strings.Contains(strings.ToLower(line), "last 5 characters") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					li.PartialKey = strings.TrimSpace(parts[1])
				}
			}
			if strings.Contains(strings.ToLower(line), "product key channel:") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					channel := strings.TrimSpace(parts[1])
					li.LicenseChannel = channel
					if strings.Contains(strings.ToLower(channel), "volume") {
						li.LicenseType = "volume"
					} else if strings.Contains(strings.ToLower(channel), "retail") {
						li.LicenseType = "retail"
					}
				}
			}
		}

		return li
	}

	// Fallback: check registry for Office version installed
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\*\*\InstallRoot' 2>$null | Select-Object -First 1`).Output()
	if err == nil && strings.TrimSpace(string(out)) != "" {
		return &LicenseInfo{
			SoftwareName:     "Microsoft Office",
			LicenseType:      "unknown",
			ActivationStatus: "unknown",
		}
	}

	return nil
}
