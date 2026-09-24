package collector

// LicenseInfo holds license data for a single software product.
type LicenseInfo struct {
	SoftwareName     string `json:"software_name"`
	LicenseType      string `json:"license_type"`       // retail, volume, oem, subscription, trial, unknown
	ActivationStatus string `json:"activation_status"`  // activated, not_activated, grace_period, expired
	PartialKey       string `json:"partial_key,omitempty"` // last 5 chars only
	ExpiryDate       string `json:"expiry_date,omitempty"`
	LicenseChannel   string `json:"license_channel,omitempty"` // MAK, KMS, RETAIL, etc.
}
