//go:build linux

package collector

import (
	"os/exec"
	"strings"
)

// CollectLicenses returns license/subscription information for Linux.
func CollectLicenses() []LicenseInfo {
	var licenses []LicenseInfo

	// RHEL/CentOS — subscription-manager
	if li := rhelSubscription(); li != nil {
		licenses = append(licenses, *li)
	}

	// SUSE — SUSEConnect
	if li := suseRegistration(); li != nil {
		licenses = append(licenses, *li)
	}

	// Ubuntu Pro (formerly Ubuntu Advantage)
	if li := ubuntuProStatus(); li != nil {
		licenses = append(licenses, *li)
	}

	return licenses
}

// rhelSubscription checks RHEL/CentOS subscription-manager status.
func rhelSubscription() *LicenseInfo {
	out, err := exec.Command("subscription-manager", "status").Output()
	if err != nil {
		return nil
	}

	content := string(out)
	lower := strings.ToLower(content)

	li := &LicenseInfo{
		SoftwareName: "Red Hat Subscription",
		LicenseType:  "subscription",
	}

	if strings.Contains(lower, "current") || strings.Contains(lower, "valid") {
		li.ActivationStatus = "activated"
	} else if strings.Contains(lower, "expired") {
		li.ActivationStatus = "expired"
	} else if strings.Contains(lower, "insufficient") || strings.Contains(lower, "not subscribed") {
		li.ActivationStatus = "not_activated"
	} else {
		li.ActivationStatus = "unknown"
	}

	// Get identity for more details
	if idOut, err2 := exec.Command("subscription-manager", "identity").Output(); err2 == nil {
		for _, line := range strings.Split(string(idOut), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(strings.ToLower(line), "system name:") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					li.SoftwareName = "Red Hat Subscription (" + strings.TrimSpace(parts[1]) + ")"
				}
			}
		}
	}

	return li
}

// suseRegistration checks SUSE registration via SUSEConnect.
func suseRegistration() *LicenseInfo {
	out, err := exec.Command("SUSEConnect", "--status").Output()
	if err != nil {
		return nil
	}

	content := strings.ToLower(string(out))

	li := &LicenseInfo{
		SoftwareName: "SUSE Registration",
		LicenseType:  "subscription",
	}

	if strings.Contains(content, "registered") {
		li.ActivationStatus = "activated"
	} else if strings.Contains(content, "not registered") {
		li.ActivationStatus = "not_activated"
	} else {
		li.ActivationStatus = "unknown"
	}

	return li
}

// ubuntuProStatus checks Ubuntu Pro (ubuntu-advantage-tools) subscription.
func ubuntuProStatus() *LicenseInfo {
	out, err := exec.Command("ua", "status", "--format", "tabular").Output()
	if err != nil {
		// Try newer 'pro' command
		out, err = exec.Command("pro", "status").Output()
		if err != nil {
			return nil
		}
	}

	content := strings.ToLower(string(out))

	li := &LicenseInfo{
		SoftwareName: "Ubuntu Pro",
		LicenseType:  "subscription",
	}

	if strings.Contains(content, "attached") {
		li.ActivationStatus = "activated"
	} else if strings.Contains(content, "detached") || strings.Contains(content, "not attached") {
		li.ActivationStatus = "not_activated"
	} else {
		li.ActivationStatus = "unknown"
	}

	return li
}
