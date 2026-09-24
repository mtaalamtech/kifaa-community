//go:build windows

package collector

import (
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// CollectSecurityState gathers security configuration on Windows.
func CollectSecurityState() SecurityState {
	s := SecurityState{}

	s.FirewallEnabled, s.FirewallProduct = windowsFirewallStatus()
	s.RDPEnabled = windowsRDPEnabled()
	s.GuestAccountEnabled = windowsGuestAccountEnabled()
	s.SMBv1Enabled = windowsSMBv1Enabled()
	s.AuditPolicyEnabled = windowsAuditPolicyEnabled()
	s.AutoUpdatesEnabled = windowsAutoUpdatesEnabled()
	s.DiskEncrypted, s.EncryptionMethod = windowsBitLockerStatus()
	s.AVInstalled, s.AVProduct, s.AVRunning, s.AVLastScan = windowsAVStatus()
	s.PasswordMinLength, s.PasswordComplexity = windowsPasswordPolicy()

	return s
}

// windowsFirewallStatus checks Windows Firewall via netsh.
func windowsFirewallStatus() (enabled bool, product string) {
	out, err := exec.Command("netsh", "advfirewall", "show", "allprofiles", "state").Output()
	if err == nil {
		if strings.Contains(strings.ToUpper(string(out)), "STATE                                 ON") {
			return true, "Windows Firewall"
		}
	}
	return false, "Windows Firewall"
}

// windowsRDPEnabled reads the registry key that controls RDP.
func windowsRDPEnabled() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Terminal Server`,
		registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	val, _, err := k.GetIntegerValue("fDenyTSConnections")
	if err != nil {
		return false
	}
	// 0 = RDP enabled, 1 = RDP disabled
	return val == 0
}

// windowsGuestAccountEnabled checks if the built-in Guest account is active.
func windowsGuestAccountEnabled() bool {
	out, err := exec.Command("net", "user", "Guest").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(strings.ToLower(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "account active") {
			return strings.HasSuffix(line, "yes")
		}
	}
	return false
}

// windowsSMBv1Enabled reads the SMBv1 registry setting.
func windowsSMBv1Enabled() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters`,
		registry.QUERY_VALUE)
	if err != nil {
		// Key missing → assume SMBv1 may be present (older OS)
		return true
	}
	defer k.Close()
	val, _, err := k.GetIntegerValue("SMB1")
	if err != nil {
		// Value not set → SMBv1 enabled by default on older Windows
		return true
	}
	return val != 0
}

// windowsAuditPolicyEnabled checks if Logon/Logoff auditing is configured.
func windowsAuditPolicyEnabled() bool {
	out, err := exec.Command("auditpol", "/get", "/category:Logon/Logoff").Output()
	if err != nil {
		return false
	}
	lower := strings.ToLower(string(out))
	return strings.Contains(lower, "success") || strings.Contains(lower, "success and failure")
}

// windowsAutoUpdatesEnabled reads Windows Update AU settings from registry.
func windowsAutoUpdatesEnabled() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update`,
		registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	// AUOptions 3 = notify before download, 4 = auto download+install
	val, _, err := k.GetIntegerValue("AUOptions")
	if err != nil {
		return false
	}
	return val >= 3
}

// windowsBitLockerStatus checks BitLocker protection on the system drive.
func windowsBitLockerStatus() (encrypted bool, method string) {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-Command", "Get-BitLockerVolume -MountPoint C: | Select-Object -ExpandProperty ProtectionStatus").Output()
	if err != nil {
		return false, ""
	}
	val := strings.TrimSpace(string(out))
	if val == "On" || val == "1" {
		return true, "BitLocker"
	}
	return false, ""
}

// windowsAVStatus queries Windows Security Center (SecurityCenter2) for ALL AV products.
// Returns all installed products (comma-separated), running state of the first active one,
// and last scan time from Windows Defender if available.
func windowsAVStatus() (installed bool, product string, running bool, lastScan string) {
	// Query ALL registered AV products, not just the first one
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName AntiVirusProduct |`+
			` ForEach-Object { Write-Output ($_.displayName + "|" + $_.productState) }`).Output()
	if err != nil {
		return false, "", false, ""
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var products []string
	anyRunning := false

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		products = append(products, name)
		if len(parts) >= 2 {
			// productState bits 12-15: real-time protection (1 = enabled)
			// Common values: 266240 (0x41000) = on+updated, 393216 (0x60000) = disabled
			if state, err2 := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err2 == nil {
				if (state>>12)&0xF == 1 {
					anyRunning = true
				}
			}
		}
	}

	if len(products) == 0 {
		return false, "", false, ""
	}

	installed = true
	running = anyRunning
	product = strings.Join(products, ", ")

	// Get last scan time from Windows Defender if present
	if scanOut, err2 := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-Command", "(Get-MpComputerStatus).QuickScanEndTime").Output(); err2 == nil {
		lastScan = strings.TrimSpace(string(scanOut))
	}

	return installed, product, running, lastScan
}

// windowsPasswordPolicy reads minimum password length via net accounts.
func windowsPasswordPolicy() (minLength int, complexity bool) {
	out, err := exec.Command("net", "accounts").Output()
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(strings.ToLower(line), "minimum password length") {
			parts := strings.Fields(line)
			if len(parts) > 0 {
				if n, err2 := strconv.Atoi(parts[len(parts)-1]); err2 == nil {
					minLength = n
				}
			}
		}
	}

	// Password complexity via secedit export to a temp file
	tmpFile := `C:\Windows\Temp\kifaa_secpol.cfg`
	if err2 := exec.Command("secedit", "/export", "/cfg", tmpFile, "/areas", "SECURITYPOLICY").Run(); err2 == nil {
		if data, err3 := readTextFile(tmpFile); err3 == nil {
			for _, line := range strings.Split(data, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(strings.ToLower(line), "passwordcomplexity") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						complexity = strings.TrimSpace(parts[1]) == "1"
					}
				}
			}
		}
		// Clean up temp file — ignore errors
		exec.Command("cmd", "/c", "del", "/f", tmpFile).Run()
	}

	return minLength, complexity
}

// readTextFile reads a text file and returns its contents as a string.
func readTextFile(path string) (string, error) {
	out, err := exec.Command("type", path).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
