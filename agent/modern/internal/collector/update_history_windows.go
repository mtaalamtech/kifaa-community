//go:build windows

package collector

import (
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

type UpdateHistoryItem struct {
	Title       string    `json:"title"`
	KB          string    `json:"kb"`
	InstalledAt time.Time `json:"installed_at"`
	Result      string    `json:"result"` // success, failed, other
	Category    string    `json:"category"`
}

type psHistoryItem struct {
	Title  string `json:"Title"`
	KB     string `json:"KB"`
	Date   string `json:"Date"`
	Result int    `json:"Result"` // 2=success, 3=success_w_errors, 4=failed, 5=aborted
}

// CollectUpdateHistory returns the last 100 installed/attempted Windows updates.
func CollectUpdateHistory() []UpdateHistoryItem {
	ps := `
$ErrorActionPreference = 'SilentlyContinue'
try {
    $session  = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $count    = $searcher.GetTotalHistoryCount()
    if ($count -eq 0) { Write-Output "[]"; exit }
    $n = [Math]::Min($count, 100)
    $hist = $searcher.QueryHistory(0, $n)
    $out  = @()
    foreach ($h in $hist) {
        $kb = ""
        if ($h.Title -match "KB(\d+)") { $kb = "KB" + $Matches[1] }
        $out += [PSCustomObject]@{
            Title  = $h.Title
            KB     = $kb
            Date   = $h.Date.ToUniversalTime().ToString("o")
            Result = [int]$h.ResultCode
        }
    }
    if ($out.Count -eq 0) { Write-Output "[]" } else { $out | ConvertTo-Json -Compress }
} catch { Write-Output "[]" }
`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	raw := strings.TrimSpace(string(out))
	if raw == "" || raw == "[]" {
		return []UpdateHistoryItem{}
	}

	// Wrap single object in array
	var items []psHistoryItem
	if strings.HasPrefix(raw, "[") {
		if err := json.Unmarshal([]byte(raw), &items); err != nil {
			return nil
		}
	} else {
		var single psHistoryItem
		if err := json.Unmarshal([]byte(raw), &single); err != nil {
			return nil
		}
		items = []psHistoryItem{single}
	}

	result := make([]UpdateHistoryItem, 0, len(items))
	for _, it := range items {
		r := "success"
		switch it.Result {
		case 4:
			r = "failed"
		case 5:
			r = "aborted"
		case 3:
			r = "success_with_errors"
		}

		t, _ := time.Parse(time.RFC3339Nano, it.Date)

		cat := "update"
		title := strings.ToLower(it.Title)
		if strings.Contains(title, "security") || strings.Contains(title, "cumulative") {
			cat = "security"
		} else if strings.Contains(title, "definition") || strings.Contains(title, "defender") {
			cat = "definition"
		} else if strings.Contains(title, "driver") {
			cat = "driver"
		}

		result = append(result, UpdateHistoryItem{
			Title:       it.Title,
			KB:          it.KB,
			InstalledAt: t,
			Result:      r,
			Category:    cat,
		})
	}
	return result
}
