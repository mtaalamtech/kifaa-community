package collector

// WebConfigFinding represents a single web server misconfiguration detected on the endpoint.
type WebConfigFinding struct {
	ServerType  string `json:"server_type"`  // nginx, apache, iis
	ConfigFile  string `json:"config_file"`
	FindingID   string `json:"finding_id"`
	Severity    string `json:"severity"`     // critical, high, medium, low
	Title       string `json:"title"`
	Detail      string `json:"detail,omitempty"`
	Remediation string `json:"remediation,omitempty"`
}
