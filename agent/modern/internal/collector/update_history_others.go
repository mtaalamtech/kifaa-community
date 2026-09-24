//go:build !windows

package collector

import (
	"os/exec"
	"strings"
	"time"
)

type UpdateHistoryItem struct {
	Title       string    `json:"title"`
	KB          string    `json:"kb"`
	InstalledAt time.Time `json:"installed_at"`
	Result      string    `json:"result"`
	Category    string    `json:"category"`
}

// CollectUpdateHistory returns recently installed packages on Linux.
func CollectUpdateHistory() []UpdateHistoryItem {
	// Try dpkg log (Debian/Ubuntu)
	out, err := exec.Command("sh", "-c",
		`grep " install \| upgrade " /var/log/dpkg.log 2>/dev/null | tail -100 | awk '{print $1,$2,$3,$4,$5}'`).Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		return parseDpkgLog(string(out))
	}

	// Try rpm (RHEL/CentOS/SLES)
	out, err = exec.Command("sh", "-c",
		`rpm -qa --last --queryformat '%{INSTALLTIME:date}|%{NAME}-%{VERSION}-%{RELEASE}\n' 2>/dev/null | head -100`).Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		return parseRpmLast(string(out))
	}

	return []UpdateHistoryItem{}
}

func parseDpkgLog(raw string) []UpdateHistoryItem {
	var items []UpdateHistoryItem
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		parts := strings.Fields(line)
		// format: date time action package version
		if len(parts) < 5 {
			continue
		}
		dateStr := parts[0] + "T" + parts[1]
		t, _ := time.Parse("2006-01-02T15:04:05", dateStr)
		action := parts[2] // install or upgrade
		pkg := parts[3]
		result := "success"
		cat := "update"
		if action == "install" {
			cat = "install"
		}
		items = append(items, UpdateHistoryItem{
			Title:       pkg,
			InstalledAt: t,
			Result:      result,
			Category:    cat,
		})
	}
	return items
}

func parseRpmLast(raw string) []UpdateHistoryItem {
	var items []UpdateHistoryItem
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		t, _ := time.Parse("Mon Jan 2 15:04:05 2006", strings.TrimSpace(parts[0]))
		items = append(items, UpdateHistoryItem{
			Title:       strings.TrimSpace(parts[1]),
			InstalledAt: t,
			Result:      "success",
			Category:    "update",
		})
	}
	return items
}
