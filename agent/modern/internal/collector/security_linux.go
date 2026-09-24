//go:build linux

package collector

import (
	"bufio"
	"os"
	"os/exec"
	"strings"
)

// CollectSecurityState gathers security configuration on Linux.
func CollectSecurityState() SecurityState {
	s := SecurityState{}

	s.FirewallEnabled, s.FirewallProduct = linuxFirewallStatus()
	s.SSHRootLogin, s.SSHPasswordAuth = linuxSSHConfig()
	s.SELinuxEnabled = linuxSELinuxEnabled()
	s.AppArmorEnabled = linuxAppArmorEnabled()
	s.AuditdRunning = linuxServiceRunning("auditd")
	s.DiskEncrypted, s.EncryptionMethod = linuxDiskEncryption()
	s.AutoUpdatesEnabled = linuxAutoUpdatesEnabled()
	s.UnattendedUpgradesEnabled = s.AutoUpdatesEnabled

	// Only report AV fields if an AV product is actually installed.
	// Linux systems often run without AV — absence is not a finding.
	s.AVInstalled, s.AVProduct, s.AVRunning = linuxAVStatus()

	return s
}

// linuxAVStatus detects common Linux AV/EDR products.
// Returns (installed=false, "", false) if none found — callers should treat
// Linux AV as "not applicable" when installed=false and platform=linux.
func linuxAVStatus() (installed bool, product string, running bool) {
	type avDef struct {
		name    string
		service string   // systemd service name to check (running)
		binary  string   // binary to check for existence (installed)
	}

	products := []avDef{
		// Sophos
		{"Sophos AV", "sophos-av", "savdid"},
		{"Sophos Intercept X", "sophoslinux", ""},
		// ClamAV
		{"ClamAV", "clamav-daemon", "clamscan"},
		{"ClamAV (freshclam)", "clamav-freshclam", ""},
		// ESET
		{"ESET NOD32", "esets_daemon", "esets_scan"},
		{"ESET Endpoint", "eset-management-agent", ""},
		// Kaspersky
		{"Kaspersky Endpoint", "kesl", "kesl-control"},
		// McAfee / Trellix
		{"McAfee / Trellix", "mfetpd", "tpxtool"},
		// Trend Micro
		{"Trend Micro", "ds_agent", ""},
		// Symantec / Broadcom
		{"Symantec EP", "smcd", "sav"},
		// Bitdefender
		{"Bitdefender", "bd-antivirus", "bdscan"},
		// F-Secure
		{"F-Secure", "fsav", "fsav"},
		// Crowdstrike Falcon
		{"CrowdStrike Falcon", "falcon-sensor", "falconctl"},
		// SentinelOne
		{"SentinelOne", "sentineld", "sentinelctl"},
		// Carbon Black
		{"VMware Carbon Black", "cbdaemon", "cbdaemon"},
		// Malwarebytes
		{"Malwarebytes", "mbbsd", ""},
	}

	var found []string
	isRunning := false

	for _, av := range products {
		detected := false

		// Check service via systemctl
		if av.service != "" {
			if out, err := exec.Command("systemctl", "is-active", av.service).Output(); err == nil {
				state := strings.TrimSpace(string(out))
				if state == "active" {
					detected = true
					isRunning = true
				} else if state == "inactive" || state == "failed" {
					detected = true // installed but not running
				}
			}
			// Also check if unit exists at all
			if !detected {
				if err := exec.Command("systemctl", "cat", av.service).Run(); err == nil {
					detected = true
				}
			}
		}

		// Check binary in PATH or /usr/bin, /opt, /usr/local/bin
		if !detected && av.binary != "" {
			if _, err := exec.LookPath(av.binary); err == nil {
				detected = true
			}
		}

		if detected {
			found = append(found, av.name)
		}
	}

	if len(found) == 0 {
		return false, "", false
	}

	return true, strings.Join(found, ", "), isRunning
}

// linuxFirewallStatus checks ufw, firewalld, then iptables for an active firewall.
func linuxFirewallStatus() (enabled bool, product string) {
	// ufw
	if out, err := exec.Command("ufw", "status").Output(); err == nil {
		if strings.Contains(strings.ToLower(string(out)), "status: active") {
			return true, "ufw"
		}
		return false, "ufw"
	}

	// firewalld
	if out, err := exec.Command("firewall-cmd", "--state").Output(); err == nil {
		if strings.TrimSpace(string(out)) == "running" {
			return true, "firewalld"
		}
		return false, "firewalld"
	}

	// iptables — consider active if there are any non-default rules
	if out, err := exec.Command("iptables", "-L", "-n", "--line-numbers").Output(); err == nil {
		lines := 0
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line != "" && !strings.HasPrefix(line, "Chain") && !strings.HasPrefix(line, "target") {
				lines++
			}
		}
		return lines > 0, "iptables"
	}

	return false, ""
}

// linuxSSHConfig reads /etc/ssh/sshd_config for PermitRootLogin and PasswordAuthentication.
func linuxSSHConfig() (rootLogin bool, passwordAuth bool) {
	f, err := os.Open("/etc/ssh/sshd_config")
	if err != nil {
		return false, false
	}
	defer f.Close()

	rootLogin = false    // default deny
	passwordAuth = false // default deny (safe default)

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.ToLower(parts[0])
		val := strings.ToLower(parts[1])
		switch key {
		case "permitrootlogin":
			rootLogin = val == "yes"
		case "passwordauthentication":
			passwordAuth = val == "yes"
		}
	}
	return rootLogin, passwordAuth
}

// linuxSELinuxEnabled checks /sys/fs/selinux/enforce or sestatus.
func linuxSELinuxEnabled() bool {
	if data, err := os.ReadFile("/sys/fs/selinux/enforce"); err == nil {
		return strings.TrimSpace(string(data)) == "1"
	}
	if out, err := exec.Command("getenforce").Output(); err == nil {
		v := strings.TrimSpace(string(out))
		return v == "Enforcing" || v == "Permissive"
	}
	return false
}

// linuxAppArmorEnabled checks if AppArmor profiles are loaded.
func linuxAppArmorEnabled() bool {
	if data, err := os.ReadFile("/sys/module/apparmor/parameters/enabled"); err == nil {
		return strings.TrimSpace(string(data)) == "Y"
	}
	if out, err := exec.Command("aa-status", "--enabled").Output(); err == nil {
		_ = out
		return true
	}
	return false
}

// linuxServiceRunning returns true if the named systemd/sysvinit service is active.
func linuxServiceRunning(name string) bool {
	if out, err := exec.Command("systemctl", "is-active", name).Output(); err == nil {
		return strings.TrimSpace(string(out)) == "active"
	}
	// fallback: service status
	if err := exec.Command("service", name, "status").Run(); err == nil {
		return true
	}
	return false
}

// linuxDiskEncryption checks for LUKS-encrypted block devices via lsblk or dmsetup.
func linuxDiskEncryption() (encrypted bool, method string) {
	if out, err := exec.Command("lsblk", "-o", "NAME,TYPE", "-J").Output(); err == nil {
		if strings.Contains(string(out), "crypt") {
			return true, "LUKS"
		}
	}
	// dmsetup list — if any dm-crypt mappings exist
	if out, err := exec.Command("dmsetup", "ls", "--target", "crypt").Output(); err == nil {
		lines := strings.TrimSpace(string(out))
		if lines != "" && lines != "No devices found" {
			return true, "LUKS"
		}
	}
	return false, ""
}

// linuxAutoUpdatesEnabled checks for unattended-upgrades or dnf-automatic or yum-cron.
func linuxAutoUpdatesEnabled() bool {
	// Debian/Ubuntu: unattended-upgrades service
	if linuxServiceRunning("unattended-upgrades") {
		return true
	}
	// RHEL/CentOS 8+: dnf-automatic
	if linuxServiceRunning("dnf-automatic.timer") || linuxServiceRunning("dnf-automatic") {
		return true
	}
	// CentOS 7: yum-cron
	if linuxServiceRunning("yum-cron") {
		return true
	}
	return false
}
