package collector

// SecurityState holds security configuration data collected from the endpoint.
// Platform-specific collectors populate the relevant fields.
type SecurityState struct {
	// Firewall
	FirewallEnabled bool   `json:"firewall_enabled"`
	FirewallProduct string `json:"firewall_product,omitempty"`

	// Windows-specific
	RDPEnabled          bool `json:"rdp_enabled,omitempty"`
	GuestAccountEnabled bool `json:"guest_account_enabled,omitempty"`
	SMBv1Enabled        bool `json:"smb1_enabled,omitempty"`
	AuditPolicyEnabled  bool `json:"audit_policy_enabled,omitempty"`
	AutoUpdatesEnabled  bool `json:"auto_updates_enabled,omitempty"`

	// Disk encryption
	DiskEncrypted    bool   `json:"disk_encrypted"`
	EncryptionMethod string `json:"encryption_method,omitempty"` // BitLocker, LUKS, etc.

	// Antivirus / endpoint protection
	AVInstalled bool   `json:"av_installed"`
	AVProduct   string `json:"av_product,omitempty"`
	AVRunning   bool   `json:"av_running,omitempty"`
	AVLastScan  string `json:"av_last_scan,omitempty"`

	// Linux-specific
	SSHRootLogin    bool `json:"ssh_root_login,omitempty"`
	SSHPasswordAuth bool `json:"ssh_password_auth,omitempty"`
	SELinuxEnabled  bool `json:"selinux_enabled,omitempty"`
	AppArmorEnabled bool `json:"apparmor_enabled,omitempty"`
	AuditdRunning   bool `json:"auditd_running,omitempty"`
	UnattendedUpgradesEnabled bool `json:"unattended_upgrades_enabled,omitempty"`

	// Password policy
	PasswordMinLength  int  `json:"password_min_length,omitempty"`
	PasswordComplexity bool `json:"password_complexity,omitempty"`
}

// OpenPort represents a single listening/established network port on the endpoint.
type OpenPort struct {
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"` // tcp, udp
	PID         int    `json:"pid,omitempty"`
	ProcessName string `json:"process_name,omitempty"`
	BindAddress string `json:"bind_address,omitempty"`
	State       string `json:"state,omitempty"` // LISTEN, ESTABLISHED, etc.
}

// SecurityReport bundles security state + open ports for a single agent report.
type SecurityReport struct {
	Security  SecurityState `json:"security"`
	OpenPorts []OpenPort    `json:"open_ports"`
}
