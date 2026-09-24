//go:build noad

// Stub implementations for builds that exclude the LDAP/AD dependency.
// Used for the legacy Windows binary (Go 1.20, supports Windows 2008 R2+).

package collector

import "time"

type ADConfig struct {
	DCHost      string
	BaseDN      string
	Username    string
	Password    string
	UseSSL      bool
	MaxPwdAge   int
	NewPassword string
}

type ADUser struct {
	SAMAccountName       string     `json:"sam_account_name"`
	UPN                  string     `json:"upn"`
	DisplayName          string     `json:"display_name"`
	Email                string     `json:"email"`
	Department           string     `json:"department"`
	Title                string     `json:"title"`
	ManagerDN            string     `json:"manager_dn"`
	OUPath               string     `json:"ou_path"`
	DistinguishedName    string     `json:"distinguished_name"`
	AccountEnabled       bool       `json:"account_enabled"`
	LockedOut            bool       `json:"locked_out"`
	LockoutTime          *time.Time `json:"lockout_time"`
	PasswordExpired      bool       `json:"password_expired"`
	PasswordNeverExpires bool       `json:"password_never_expires"`
	PasswordLastSet      *time.Time `json:"password_last_set"`
	PasswordExpiresAt    *time.Time `json:"password_expires_at"`
	LastLogon            *time.Time `json:"last_logon"`
	CreatedAt            *time.Time `json:"created_at_ad"`
	MemberOf             []string   `json:"member_of"`
	IsAdmin              bool       `json:"is_admin"`
	IsServiceAccount     bool       `json:"is_service_account"`
	DaysSinceLogon       *int       `json:"days_since_logon"`
	UserAccountControl   int        `json:"user_account_control"`
}

type ADGroup struct {
	SAMAccountName string   `json:"sam_account_name"`
	DisplayName    string   `json:"display_name"`
	Description    string   `json:"description"`
	GroupType      string   `json:"group_type"`
	GroupScope     string   `json:"group_scope"`
	Members        []string `json:"members"`
	OUPath         string   `json:"ou_path"`
	IsPrivileged   bool     `json:"is_privileged"`
}

type ADStats struct {
	TotalUsers          int `json:"total_users"`
	EnabledUsers        int `json:"enabled_users"`
	DisabledUsers       int `json:"disabled_users"`
	LockedUsers         int `json:"locked_users"`
	Stale30d            int `json:"stale_users_30d"`
	Stale90d            int `json:"stale_users_90d"`
	ExpiringPwd7d       int `json:"expiring_passwords_7d"`
	ExpiredPwd          int `json:"expired_passwords"`
	NeverExpirePwd      int `json:"never_expire_passwords"`
	AdminCount          int `json:"admin_count"`
	ServiceAccountCount int `json:"service_account_count"`
	TotalGroups         int `json:"total_groups"`
	PrivilegedGroups    int `json:"privileged_groups"`
}

type ADSyncResult struct {
	Users  []ADUser  `json:"users"`
	Groups []ADGroup `json:"groups"`
	Stats  ADStats   `json:"stats"`
	Error  string    `json:"error,omitempty"`
}

type ADActionResult struct {
	ActionID string `json:"action_id"`
	Success  bool   `json:"success"`
	Message  string `json:"message"`
}

type ADEvent struct {
	EventID         int       `json:"event_id"`
	EventTime       time.Time `json:"event_time"`
	TargetUser      string    `json:"target_user"`
	TargetDomain    string    `json:"target_domain"`
	CallingComputer string    `json:"calling_computer"`
	CallingIP       string    `json:"calling_ip"`
	DCName          string    `json:"dc_name"`
	SubjectUser     string    `json:"subject_user"`
	Description     string    `json:"description"`
}

type ADTestResult struct {
	CommandID string `json:"command_id"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	LatencyMs int    `json:"latency_ms"`
}

func RunADSync(_ ADConfig) ADSyncResult {
	return ADSyncResult{Error: "AD not supported on this build"}
}

func RunADUserAction(_ ADConfig, _, _, actionID string) ADActionResult {
	return ADActionResult{ActionID: actionID, Success: false, Message: "AD not supported on this build"}
}

func RunADTest(_ ADConfig, commandID string) ADTestResult {
	return ADTestResult{CommandID: commandID, Success: false, Message: "AD not supported on this build"}
}

func ReadADEvents(_ int) []ADEvent { return nil }
