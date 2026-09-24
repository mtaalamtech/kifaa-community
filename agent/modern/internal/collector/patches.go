package collector

// PatchInfo describes a single pending OS/software update.
type PatchInfo struct {
	PackageName       string `json:"package_name"`
	CurrentVersion    string `json:"current_version"`
	AvailableVersion  string `json:"available_version"`
	Category          string `json:"category"` // security, upgrade, unknown
	Description       string `json:"description"`
	CompatibilityNote string `json:"compatibility_note,omitempty"` // non-empty if upgrade may have issues
}
