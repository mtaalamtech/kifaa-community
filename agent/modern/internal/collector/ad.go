//go:build !noad

package collector

import (
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/go-ldap/ldap/v3"
)

// ── AD Config ─────────────────────────────────────────────────────────────────

type ADConfig struct {
	DCHost      string
	BaseDN      string
	Username    string // DOMAIN\user or user@domain.com
	Password    string
	UseSSL      bool
	MaxPwdAge   int    // days, default 90
	NewPassword string // used only for change_password action
}

// ── AD Data Structures ────────────────────────────────────────────────────────

type ADUser struct {
	SAMAccountName      string     `json:"sam_account_name"`
	UPN                 string     `json:"upn"`
	DisplayName         string     `json:"display_name"`
	Email               string     `json:"email"`
	Department          string     `json:"department"`
	Title               string     `json:"title"`
	ManagerDN           string     `json:"manager_dn"`
	OUPath              string     `json:"ou_path"`
	DistinguishedName   string     `json:"distinguished_name"`
	AccountEnabled      bool       `json:"account_enabled"`
	LockedOut           bool       `json:"locked_out"`
	LockoutTime         *time.Time `json:"lockout_time"`
	PasswordExpired     bool       `json:"password_expired"`
	PasswordNeverExpires bool      `json:"password_never_expires"`
	PasswordLastSet     *time.Time `json:"password_last_set"`
	PasswordExpiresAt   *time.Time `json:"password_expires_at"`
	LastLogon           *time.Time `json:"last_logon"`
	CreatedAt           *time.Time `json:"created_at_ad"`
	MemberOf            []string   `json:"member_of"`
	IsAdmin             bool       `json:"is_admin"`
	IsServiceAccount    bool       `json:"is_service_account"`
	DaysSinceLogon      *int       `json:"days_since_logon"`
	UserAccountControl  int        `json:"user_account_control"`
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

type ADSyncResult struct {
	Users  []ADUser  `json:"users"`
	Groups []ADGroup `json:"groups"`
	Stats  ADStats   `json:"stats"`
	Error  string    `json:"error,omitempty"`
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

type ADActionResult struct {
	ActionID string `json:"action_id"`
	Success  bool   `json:"success"`
	Message  string `json:"message"`
}

type ADEvent struct {
	EventID          int        `json:"event_id"`
	EventTime        time.Time  `json:"event_time"`
	TargetUser       string     `json:"target_user"`
	TargetDomain     string     `json:"target_domain"`
	CallingComputer  string     `json:"calling_computer"`
	CallingIP        string     `json:"calling_ip"`
	DCName           string     `json:"dc_name"`
	SubjectUser      string     `json:"subject_user"`
	Description      string     `json:"description"`
}

// ── Privileged groups ─────────────────────────────────────────────────────────

var privilegedGroupNames = map[string]bool{
	"domain admins":      true,
	"enterprise admins":  true,
	"schema admins":      true,
	"administrators":     true,
	"group policy creator owners": true,
	"account operators":  true,
	"backup operators":   true,
	"print operators":    true,
	"server operators":   true,
}

// ── LDAP Helpers ──────────────────────────────────────────────────────────────

// fileTimeToTime converts Windows FILETIME (100-ns intervals since 1601) to time.Time.
func fileTimeToTime(ft int64) *time.Time {
	if ft <= 0 || ft == 9223372036854775807 {
		return nil
	}
	// Windows epoch to Unix epoch offset: 11644473600 seconds
	unixNano := (ft - 116444736000000000) * 100
	t := time.Unix(0, unixNano).UTC()
	return &t
}

func parseFileTimeAttr(entry *ldap.Entry, attr string) *time.Time {
	v := entry.GetAttributeValue(attr)
	if v == "" || v == "0" {
		return nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return nil
	}
	return fileTimeToTime(n)
}

func getOUFromDN(dn string) string {
	parts := strings.Split(dn, ",")
	var ous []string
	for _, p := range parts {
		if strings.HasPrefix(strings.ToUpper(p), "OU=") {
			ous = append(ous, p[3:])
		}
	}
	if len(ous) == 0 {
		return ""
	}
	// Reverse to get top-level first
	for i, j := 0, len(ous)-1; i < j; i, j = i+1, j-1 {
		ous[i], ous[j] = ous[j], ous[i]
	}
	return strings.Join(ous, " / ")
}

func containsAdmin(memberOf []string) bool {
	for _, g := range memberOf {
		parts := strings.Split(g, ",")
		for _, p := range parts {
			if strings.HasPrefix(strings.ToUpper(p), "CN=") {
				name := strings.ToLower(p[3:])
				if privilegedGroupNames[name] {
					return true
				}
			}
		}
	}
	return false
}

// ── LDAP Connection ───────────────────────────────────────────────────────────

func ConnectLDAP(cfg ADConfig) (*ldap.Conn, error) {
	port := 389
	if cfg.UseSSL {
		port = 636
	}
	addr := fmt.Sprintf("%s:%d", cfg.DCHost, port)

	var conn *ldap.Conn
	var err error
	if cfg.UseSSL {
		// Skip certificate verification — AD DCs typically use self-signed certs for LDAPS.
		// unicodePwd changes require TLS but the cert is internal and not publicly trusted.
		tlsCfg := &tls.Config{InsecureSkipVerify: true, ServerName: cfg.DCHost}
		conn, err = ldap.DialTLS("tcp", addr, tlsCfg)
	} else {
		conn, err = ldap.Dial("tcp", addr)
	}
	if err != nil {
		return nil, fmt.Errorf("LDAP dial %s: %w", addr, err)
	}
	if err := conn.Bind(cfg.Username, cfg.Password); err != nil {
		conn.Close()
		return nil, fmt.Errorf("LDAP bind as %s: %w", cfg.Username, err)
	}
	return conn, nil
}

// DiscoverDC tries to find a DC via DNS SRV record.
func DiscoverDC(domain string) (string, error) {
	_, addrs, err := net.LookupSRV("ldap", "tcp", domain)
	if err != nil || len(addrs) == 0 {
		return "", fmt.Errorf("DNS SRV lookup for %s failed: %w", domain, err)
	}
	host := strings.TrimSuffix(addrs[0].Target, ".")
	return host, nil
}

// ── User Sync ─────────────────────────────────────────────────────────────────

func SyncADUsers(conn *ldap.Conn, cfg ADConfig) ([]ADUser, error) {
	attrs := []string{
		"sAMAccountName", "userPrincipalName", "displayName", "mail",
		"department", "title", "manager", "distinguishedName",
		"userAccountControl", "lockoutTime", "pwdLastSet",
		"lastLogon", "lastLogonTimestamp", "whenCreated",
		"memberOf", "msDS-UserPasswordExpiryTimeComputed",
	}

	// Use paging to handle large directories
	pagingControl := ldap.NewControlPaging(500)
	var users []ADUser
	now := time.Now()
	maxPwdAge := time.Duration(cfg.MaxPwdAge) * 24 * time.Hour

	for {
		searchReq := ldap.NewSearchRequest(
			cfg.BaseDN,
			ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false,
			"(&(objectClass=user)(objectCategory=person))",
			attrs,
			[]ldap.Control{pagingControl},
		)

		sr, err := conn.Search(searchReq)
		if err != nil {
			return nil, fmt.Errorf("LDAP user search: %w", err)
		}

		for _, entry := range sr.Entries {
			uac := 0
			if v := entry.GetAttributeValue("userAccountControl"); v != "" {
				uac, _ = strconv.Atoi(v)
			}

			enabled := (uac & 0x0002) == 0
			lockedOut := (uac & 0x0010) != 0
			pwdNeverExpires := (uac & 0x10000) != 0
			pwdExpired := (uac & 0x800000) != 0

			lockoutTime := parseFileTimeAttr(entry, "lockoutTime")
			if lockoutTime != nil && lockoutTime.Year() < 1990 {
				lockoutTime = nil
			}
			// lockoutTime > 0 means locked
			if lv := entry.GetAttributeValue("lockoutTime"); lv != "" && lv != "0" {
				n, _ := strconv.ParseInt(lv, 10, 64)
				if n > 0 {
					lockedOut = true
				}
			}

			pwdLastSet := parseFileTimeAttr(entry, "pwdLastSet")

			// Last logon: take max of lastLogon and lastLogonTimestamp
			lastLogon := parseFileTimeAttr(entry, "lastLogon")
			lastLogonTS := parseFileTimeAttr(entry, "lastLogonTimestamp")
			if lastLogonTS != nil {
				if lastLogon == nil || lastLogonTS.After(*lastLogon) {
					lastLogon = lastLogonTS
				}
			}

			// Password expiry
			var pwdExpiresAt *time.Time
			if expiryFT := entry.GetAttributeValue("msDS-UserPasswordExpiryTimeComputed"); expiryFT != "" {
				n, _ := strconv.ParseInt(expiryFT, 10, 64)
				if n > 0 && n != 9223372036854775807 {
					t := fileTimeToTime(n)
					pwdExpiresAt = t
				}
			} else if pwdLastSet != nil && !pwdNeverExpires && maxPwdAge > 0 {
				t := pwdLastSet.Add(maxPwdAge)
				pwdExpiresAt = &t
			}

			createdAt := parseFileTimeAttr(entry, "whenCreated")

			memberOf := entry.GetAttributeValues("memberOf")
			isAdmin := containsAdmin(memberOf)

			// Service account heuristic: pwd never expires AND no recent logon AND enabled
			isServiceAccount := false
			if pwdNeverExpires && enabled {
				if lastLogon == nil || now.Sub(*lastLogon) > 365*24*time.Hour {
					isServiceAccount = true
				}
			}

			var daysSinceLogon *int
			if lastLogon != nil {
				d := int(now.Sub(*lastLogon).Hours() / 24)
				daysSinceLogon = &d
			}

			dn := entry.GetAttributeValue("distinguishedName")
			ouPath := getOUFromDN(dn)

			users = append(users, ADUser{
				SAMAccountName:      entry.GetAttributeValue("sAMAccountName"),
				UPN:                 entry.GetAttributeValue("userPrincipalName"),
				DisplayName:         entry.GetAttributeValue("displayName"),
				Email:               entry.GetAttributeValue("mail"),
				Department:          entry.GetAttributeValue("department"),
				Title:               entry.GetAttributeValue("title"),
				ManagerDN:           entry.GetAttributeValue("manager"),
				OUPath:              ouPath,
				DistinguishedName:   dn,
				AccountEnabled:      enabled,
				LockedOut:           lockedOut,
				LockoutTime:         lockoutTime,
				PasswordExpired:     pwdExpired,
				PasswordNeverExpires: pwdNeverExpires,
				PasswordLastSet:     pwdLastSet,
				PasswordExpiresAt:   pwdExpiresAt,
				LastLogon:           lastLogon,
				CreatedAt:           parseFileTimeAttr(entry, "whenCreated"),
				MemberOf:            memberOf,
				IsAdmin:             isAdmin,
				IsServiceAccount:    isServiceAccount,
				DaysSinceLogon:      daysSinceLogon,
				UserAccountControl:  uac,
			})
			_ = createdAt
		}

		// Handle paging
		updatedControl := ldap.FindControl(sr.Controls, ldap.ControlTypePaging)
		if ctrl, ok := updatedControl.(*ldap.ControlPaging); ok && len(ctrl.Cookie) != 0 {
			pagingControl.SetCookie(ctrl.Cookie)
		} else {
			break
		}
	}

	return users, nil
}

// ── Group Sync ────────────────────────────────────────────────────────────────

func SyncADGroups(conn *ldap.Conn, baseDN string) ([]ADGroup, error) {
	searchReq := ldap.NewSearchRequest(
		baseDN,
		ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=group)",
		[]string{"sAMAccountName", "displayName", "description", "groupType", "member", "distinguishedName"},
		nil,
	)

	sr, err := conn.Search(searchReq)
	if err != nil {
		return nil, fmt.Errorf("LDAP group search: %w", err)
	}

	var groups []ADGroup
	for _, entry := range sr.Entries {
		sam := entry.GetAttributeValue("sAMAccountName")
		dn := entry.GetAttributeValue("distinguishedName")
		ouPath := getOUFromDN(dn)

		// Parse groupType bitmask
		gtStr := entry.GetAttributeValue("groupType")
		gt, _ := strconv.ParseInt(gtStr, 10, 64)
		groupType := "distribution"
		if gt&0x80000000 != 0 {
			groupType = "security"
		}
		groupScope := "global"
		if gt&0x00000002 != 0 {
			groupScope = "global"
		} else if gt&0x00000004 != 0 {
			groupScope = "domain_local"
		} else if gt&0x00000008 != 0 {
			groupScope = "universal"
		}

		// Extract member CN names (simplified — just the CN part)
		rawMembers := entry.GetAttributeValues("member")
		var members []string
		for _, m := range rawMembers {
			parts := strings.Split(m, ",")
			if len(parts) > 0 && strings.HasPrefix(strings.ToUpper(parts[0]), "CN=") {
				members = append(members, parts[0][3:])
			}
		}

		isPrivileged := privilegedGroupNames[strings.ToLower(sam)]

		groups = append(groups, ADGroup{
			SAMAccountName: sam,
			DisplayName:    entry.GetAttributeValue("displayName"),
			Description:    entry.GetAttributeValue("description"),
			GroupType:      groupType,
			GroupScope:     groupScope,
			Members:        members,
			OUPath:         ouPath,
			IsPrivileged:   isPrivileged,
		})
	}

	return groups, nil
}

// ── User Actions ──────────────────────────────────────────────────────────────

func findUserDN(conn *ldap.Conn, baseDN, samAccountName string) (string, int, error) {
	sr, err := conn.Search(ldap.NewSearchRequest(
		baseDN,
		ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 1, 0, false,
		fmt.Sprintf("(&(objectClass=user)(sAMAccountName=%s))", ldap.EscapeFilter(samAccountName)),
		[]string{"distinguishedName", "userAccountControl"},
		nil,
	))
	if err != nil {
		return "", 0, fmt.Errorf("find user: %w", err)
	}
	if len(sr.Entries) == 0 {
		return "", 0, fmt.Errorf("user %s not found", samAccountName)
	}
	dn := sr.Entries[0].GetAttributeValue("distinguishedName")
	uac, _ := strconv.Atoi(sr.Entries[0].GetAttributeValue("userAccountControl"))
	return dn, uac, nil
}

func UnlockADUser(conn *ldap.Conn, baseDN, sam, actionID string) ADActionResult {
	dn, _, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	mod := ldap.NewModifyRequest(dn, nil)
	mod.Replace("lockoutTime", []string{"0"})
	if err := conn.Modify(mod); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP modify failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "User unlocked successfully"}
}

func EnableADUser(conn *ldap.Conn, baseDN, sam, actionID string) ADActionResult {
	dn, uac, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	newUAC := uac &^ 0x0002 // clear ACCOUNTDISABLE bit
	mod := ldap.NewModifyRequest(dn, nil)
	mod.Replace("userAccountControl", []string{strconv.Itoa(newUAC)})
	if err := conn.Modify(mod); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP modify failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "User enabled successfully"}
}

func DisableADUser(conn *ldap.Conn, baseDN, sam, actionID string) ADActionResult {
	dn, uac, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	newUAC := uac | 0x0002 // set ACCOUNTDISABLE bit
	mod := ldap.NewModifyRequest(dn, nil)
	mod.Replace("userAccountControl", []string{strconv.Itoa(newUAC)})
	if err := conn.Modify(mod); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP modify failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "User disabled successfully"}
}

// ChangeADPassword resets a user's password via LDAP unicodePwd (requires LDAPS/TLS).
func ChangeADPassword(conn *ldap.Conn, baseDN, sam, newPwd, actionID string) ADActionResult {
	dn, _, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	encoded := encodeUnicodePwd(newPwd)
	mod := ldap.NewModifyRequest(dn, nil)
	mod.Replace("unicodePwd", []string{string(encoded)})
	if err := conn.Modify(mod); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP modify unicodePwd failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "Password changed successfully"}
}

// ForcePasswordChange sets pwdLastSet=0 so the user must change password at next logon.
func ForcePasswordChange(conn *ldap.Conn, baseDN, sam, actionID string) ADActionResult {
	dn, _, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	mod := ldap.NewModifyRequest(dn, nil)
	mod.Replace("pwdLastSet", []string{"0"})
	if err := conn.Modify(mod); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP modify pwdLastSet failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "User will be forced to change password at next logon"}
}

// encodeUnicodePwd converts a plain-text password to the Windows unicodePwd wire format:
// UTF-16LE bytes of the quoted string "password".
func encodeUnicodePwd(pwd string) []byte {
	quoted := `"` + pwd + `"`
	runes := utf16.Encode([]rune(quoted))
	buf := make([]byte, len(runes)*2)
	for i, r := range runes {
		binary.LittleEndian.PutUint16(buf[i*2:], r)
	}
	return buf
}

// ── Full Sync ─────────────────────────────────────────────────────────────────

func RunADSync(cfg ADConfig) ADSyncResult {
	conn, err := ConnectLDAP(cfg)
	if err != nil {
		return ADSyncResult{Error: err.Error()}
	}
	defer conn.Close()

	users, err := SyncADUsers(conn, cfg)
	if err != nil {
		return ADSyncResult{Error: "user sync: " + err.Error()}
	}

	groups, err := SyncADGroups(conn, cfg.BaseDN)
	if err != nil {
		return ADSyncResult{Error: "group sync: " + err.Error()}
	}

	// Compute stats
	now := time.Now()
	stats := ADStats{
		TotalUsers:  len(users),
		TotalGroups: len(groups),
	}
	for _, u := range users {
		if u.AccountEnabled {
			stats.EnabledUsers++
		} else {
			stats.DisabledUsers++
		}
		if u.LockedOut {
			stats.LockedUsers++
		}
		if u.IsAdmin {
			stats.AdminCount++
		}
		if u.IsServiceAccount {
			stats.ServiceAccountCount++
		}
		if u.PasswordNeverExpires {
			stats.NeverExpirePwd++
		}
		if u.PasswordExpired {
			stats.ExpiredPwd++
		}
		if u.LastLogon != nil {
			days := int(now.Sub(*u.LastLogon).Hours() / 24)
			if days > 30 {
				stats.Stale30d++
			}
			if days > 90 {
				stats.Stale90d++
			}
		} else {
			stats.Stale90d++
			stats.Stale30d++
		}
		if u.PasswordExpiresAt != nil {
			diff := u.PasswordExpiresAt.Sub(now)
			if diff > 0 && diff < 7*24*time.Hour {
				stats.ExpiringPwd7d++
			}
		}
	}
	for _, g := range groups {
		if g.IsPrivileged {
			stats.PrivilegedGroups++
		}
	}

	return ADSyncResult{Users: users, Groups: groups, Stats: stats}
}

// RunADUserAction connects to AD and performs unlock/enable/disable.
func RunADUserAction(cfg ADConfig, action, sam, actionID string) ADActionResult {
	conn, err := ConnectLDAP(cfg)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP connect: " + err.Error()}
	}
	defer conn.Close()

	switch action {
	case "unlock":
		return UnlockADUser(conn, cfg.BaseDN, sam, actionID)
	case "enable":
		return EnableADUser(conn, cfg.BaseDN, sam, actionID)
	case "disable":
		return DisableADUser(conn, cfg.BaseDN, sam, actionID)
	case "change_password":
		return ChangeADPassword(conn, cfg.BaseDN, sam, cfg.NewPassword, actionID)
	case "force_password_change":
		return ForcePasswordChange(conn, cfg.BaseDN, sam, actionID)
	case "delete":
		return DeleteADUser(conn, cfg.BaseDN, sam, actionID)
	default:
		return ADActionResult{ActionID: actionID, Success: false, Message: "unknown action: " + action}
	}
}

func DeleteADUser(conn *ldap.Conn, baseDN, sam, actionID string) ADActionResult {
	dn, _, err := findUserDN(conn, baseDN, sam)
	if err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: err.Error()}
	}
	del := ldap.NewDelRequest(dn, nil)
	if err := conn.Del(del); err != nil {
		return ADActionResult{ActionID: actionID, Success: false, Message: "LDAP delete failed: " + err.Error()}
	}
	return ADActionResult{ActionID: actionID, Success: true, Message: "User deleted successfully"}
}

// ADTestResult holds the result of a connectivity/auth test.
type ADTestResult struct {
	CommandID string `json:"command_id"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	LatencyMs int    `json:"latency_ms"`
}

// RunADTest attempts an LDAP bind and a simple search to verify credentials.
func RunADTest(cfg ADConfig, commandID string) ADTestResult {
	start := time.Now()

	conn, err := ConnectLDAP(cfg)
	if err != nil {
		return ADTestResult{CommandID: commandID, Success: false,
			Message:   "Connection failed: " + err.Error(),
			LatencyMs: int(time.Since(start).Milliseconds())}
	}
	defer conn.Close()

	// Try a simple base-object search to confirm the bind worked and base DN is valid
	sr := ldap.NewSearchRequest(
		cfg.BaseDN, ldap.ScopeBaseObject, ldap.NeverDerefAliases,
		1, 5, false,
		"(objectClass=*)", []string{"distinguishedName"}, nil,
	)
	_, err = conn.Search(sr)
	latency := int(time.Since(start).Milliseconds())
	if err != nil {
		return ADTestResult{CommandID: commandID, Success: false,
			Message:   "Bind succeeded but base DN search failed: " + err.Error(),
			LatencyMs: latency}
	}

	return ADTestResult{
		CommandID: commandID,
		Success:   true,
		Message:   fmt.Sprintf("Connected and authenticated successfully (latency %dms)", latency),
		LatencyMs: latency,
	}
}
