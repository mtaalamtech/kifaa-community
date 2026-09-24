//go:build windows

package collector

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

type SoftwareItem struct {
	Name        string  `json:"name"`
	Version     string  `json:"version,omitempty"`
	Publisher   string  `json:"publisher,omitempty"`
	InstallDate string  `json:"install_date,omitempty"`
	SizeMB      float64 `json:"size_mb,omitempty"`
}

var uninstallPaths = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

// releaseTypeExclusions matches entries that are updates/patches, not user-installable apps.
var releaseTypeExclusions = []string{
	"update", "hotfix", "servicepack", "security update", "kb article", "cumulative update",
}

func CollectSoftware() []SoftwareItem {
	var items []SoftwareItem
	seen := make(map[string]bool)

	roots := []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER}
	for _, root := range roots {
		for _, path := range uninstallPaths {
			key, err := registry.OpenKey(root, path, registry.READ)
			if err != nil {
				continue
			}
			subkeys, _ := key.ReadSubKeyNames(-1)
			for _, sub := range subkeys {
				subkey, err := registry.OpenKey(key, sub, registry.READ)
				if err != nil {
					continue
				}

				// ── Filter 1: must have a DisplayName ────────────────────────
				name, _, _ := subkey.GetStringValue("DisplayName")
				if name == "" {
					subkey.Close()
					continue
				}

				// ── Filter 2: exclude system components ───────────────────────
				// SystemComponent=1 means it's a Windows internal component
				sysComp, _, _ := subkey.GetIntegerValue("SystemComponent")
				if sysComp == 1 {
					subkey.Close()
					continue
				}

				// ── Filter 3: exclude sub-packages of larger products ─────────
				// ParentKeyName set means it's a feature/component of another app
				parentKey, _, _ := subkey.GetStringValue("ParentKeyName")
				if parentKey != "" {
					subkey.Close()
					continue
				}

				// ── Filter 4: exclude Windows Update patches/hotfixes ─────────
				releaseType, _, _ := subkey.GetStringValue("ReleaseType")
				if releaseType != "" {
					rt := strings.ToLower(releaseType)
					excluded := false
					for _, ex := range releaseTypeExclusions {
						if strings.Contains(rt, ex) {
							excluded = true
							break
						}
					}
					if excluded {
						subkey.Close()
						continue
					}
				}

				// ── Filter 5: exclude entries hidden from Programs & Features ─
				// NoRemove=1 means the app doesn't want to appear in the list
				noRemove, _, _ := subkey.GetIntegerValue("NoRemove")
				if noRemove == 1 {
					subkey.Close()
					continue
				}

				// ── Filter 6: deduplicate by name ─────────────────────────────
				if seen[name] {
					subkey.Close()
					continue
				}
				seen[name] = true

				version, _, _ := subkey.GetStringValue("DisplayVersion")
				publisher, _, _ := subkey.GetStringValue("Publisher")
				installDate, _, _ := subkey.GetStringValue("InstallDate")
				estimatedSize, _, _ := subkey.GetIntegerValue("EstimatedSize")
				subkey.Close()

				items = append(items, SoftwareItem{
					Name:        name,
					Version:     version,
					Publisher:   publisher,
					InstallDate: installDate,
					SizeMB:      float64(estimatedSize) / 1024,
				})
			}
			key.Close()
		}
	}
	return items
}
