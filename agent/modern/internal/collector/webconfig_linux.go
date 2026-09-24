//go:build linux

package collector

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// CollectWebConfig checks nginx, Apache, and other web server configurations on Linux.
func CollectWebConfig() []WebConfigFinding {
	var findings []WebConfigFinding

	// Nginx
	for _, path := range []string{
		"/etc/nginx/nginx.conf",
		"/etc/nginx/sites-enabled/default",
	} {
		if _, err := os.Stat(path); err == nil {
			findings = append(findings, checkNginxConfig(path)...)
		}
	}
	// Also check conf.d/
	for _, glob := range []string{"/etc/nginx/conf.d/*.conf", "/etc/nginx/sites-enabled/*"} {
		matches, _ := filepath.Glob(glob)
		for _, m := range matches {
			findings = append(findings, checkNginxConfig(m)...)
		}
	}

	// Apache
	for _, path := range []string{
		"/etc/apache2/apache2.conf",
		"/etc/httpd/conf/httpd.conf",
		"/etc/apache2/sites-enabled/000-default.conf",
	} {
		if _, err := os.Stat(path); err == nil {
			findings = append(findings, checkApacheConfig(path)...)
		}
	}

	return deduplicateFindings(findings)
}

// checkNginxConfig inspects a single nginx config file for security issues.
func checkNginxConfig(path string) []WebConfigFinding {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(data)
	lower := strings.ToLower(content)
	var findings []WebConfigFinding

	// server_tokens off
	if !strings.Contains(lower, "server_tokens off") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "nginx",
			ConfigFile:  path,
			FindingID:   "NGINX_SERVER_TOKENS_ON",
			Severity:    "medium",
			Title:       "nginx server_tokens not disabled",
			Detail:      "server_tokens on exposes nginx version in error pages and response headers.",
			Remediation: "Add 'server_tokens off;' in the http {} block in " + path,
		})
	}

	// autoindex off
	if strings.Contains(lower, "autoindex on") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "nginx",
			ConfigFile:  path,
			FindingID:   "NGINX_AUTOINDEX_ON",
			Severity:    "high",
			Title:       "nginx directory listing (autoindex) is enabled",
			Detail:      "autoindex on allows browsing of directory contents.",
			Remediation: "Set 'autoindex off;' in all server/location blocks.",
		})
	}

	// SSL protocols
	if strings.Contains(lower, "ssl_protocols") {
		if strings.Contains(lower, "tlsv1 ") || strings.Contains(lower, "sslv3") || strings.Contains(lower, "tlsv1.1") {
			findings = append(findings, WebConfigFinding{
				ServerType:  "nginx",
				ConfigFile:  path,
				FindingID:   "NGINX_WEAK_TLS",
				Severity:    "high",
				Title:       "nginx allows weak TLS versions (TLS 1.0/1.1 or SSLv3)",
				Detail:      "Old TLS versions have known vulnerabilities (POODLE, BEAST, etc.).",
				Remediation: "Set 'ssl_protocols TLSv1.2 TLSv1.3;' in " + path,
			})
		}
	}

	// HSTS header
	if strings.Contains(lower, "listen 443") || strings.Contains(lower, "ssl on") {
		if !strings.Contains(lower, "strict-transport-security") {
			findings = append(findings, WebConfigFinding{
				ServerType:  "nginx",
				ConfigFile:  path,
				FindingID:   "NGINX_NO_HSTS",
				Severity:    "medium",
				Title:       "HSTS header not configured on HTTPS site",
				Detail:      "HSTS prevents protocol downgrade attacks.",
				Remediation: "Add: add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;",
			})
		}
	}

	// Exposed .git directory
	if hasGitDirectory(path) {
		findings = append(findings, WebConfigFinding{
			ServerType:  "nginx",
			ConfigFile:  path,
			FindingID:   "WEBROOT_GIT_EXPOSED",
			Severity:    "critical",
			Title:       ".git directory may be accessible in web root",
			Detail:      "A .git directory in the web root can expose source code and credentials.",
			Remediation: "Add 'location ~ /\\.git { deny all; }' to nginx config, or move the web root outside the git repository.",
		})
	}

	return findings
}

// checkApacheConfig inspects an Apache config file for security issues.
func checkApacheConfig(path string) []WebConfigFinding {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(data)
	lower := strings.ToLower(content)
	var findings []WebConfigFinding

	// ServerTokens
	if !strings.Contains(lower, "servertokens prod") && !strings.Contains(lower, "servertokens minimal") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "apache",
			ConfigFile:  path,
			FindingID:   "APACHE_SERVER_TOKENS",
			Severity:    "medium",
			Title:       "Apache ServerTokens not set to minimal",
			Detail:      "ServerTokens Full exposes Apache version and OS in HTTP headers.",
			Remediation: "Set 'ServerTokens Prod' and 'ServerSignature Off' in " + path,
		})
	}

	// Options Indexes (directory listing)
	if strings.Contains(lower, "options indexes") || strings.Contains(lower, "options +indexes") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "apache",
			ConfigFile:  path,
			FindingID:   "APACHE_DIRECTORY_LISTING",
			Severity:    "high",
			Title:       "Apache directory listing (Options Indexes) is enabled",
			Detail:      "Directory listing allows browsing of server directories.",
			Remediation: "Remove 'Indexes' from Options directive or use 'Options -Indexes'.",
		})
	}

	// Weak TLS
	if strings.Contains(lower, "sslprotocol") {
		if strings.Contains(lower, "tlsv1 ") || strings.Contains(lower, "sslv3") || strings.Contains(lower, "tlsv1.1") {
			findings = append(findings, WebConfigFinding{
				ServerType:  "apache",
				ConfigFile:  path,
				FindingID:   "APACHE_WEAK_TLS",
				Severity:    "high",
				Title:       "Apache allows weak TLS versions",
				Detail:      "TLS 1.0/1.1 and SSLv3 have known vulnerabilities.",
				Remediation: "Set 'SSLProtocol -all +TLSv1.2 +TLSv1.3' in " + path,
			})
		}
	}

	// HSTS
	if strings.Contains(lower, "virtualhost") && strings.Contains(lower, "443") {
		if !strings.Contains(lower, "strict-transport-security") {
			findings = append(findings, WebConfigFinding{
				ServerType:  "apache",
				ConfigFile:  path,
				FindingID:   "APACHE_NO_HSTS",
				Severity:    "medium",
				Title:       "HSTS header not configured on HTTPS virtual host",
				Remediation: "Add: Header always set Strict-Transport-Security \"max-age=31536000; includeSubDomains\"",
			})
		}
	}

	// .htaccess overrides (if AllowOverride All is set — potential security bypass)
	if strings.Contains(lower, "allowoverride all") {
		findings = append(findings, WebConfigFinding{
			ServerType:  "apache",
			ConfigFile:  path,
			FindingID:   "APACHE_ALLOWOVERRIDE_ALL",
			Severity:    "low",
			Title:       "Apache AllowOverride All permits .htaccess overrides",
			Detail:      "AllowOverride All can allow .htaccess files to override security settings.",
			Remediation: "Set 'AllowOverride None' or restrict to specific directives as needed.",
		})
	}

	return findings
}

// hasGitDirectory checks if the likely web root directory contains a .git folder.
func hasGitDirectory(configPath string) bool {
	// Look for 'root' directive in nginx or DocumentRoot in apache
	f, err := os.Open(configPath)
	if err != nil {
		return false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		lower := strings.ToLower(line)

		var webRoot string
		if strings.HasPrefix(lower, "root ") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				webRoot = strings.TrimRight(parts[1], ";")
			}
		} else if strings.HasPrefix(lower, "documentroot ") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				webRoot = parts[1]
			}
		}

		if webRoot != "" {
			gitPath := filepath.Join(webRoot, ".git")
			if _, err := os.Stat(gitPath); err == nil {
				return true
			}
		}
	}
	return false
}

// deduplicateFindings removes duplicate findings (same FindingID + ConfigFile).
func deduplicateFindings(findings []WebConfigFinding) []WebConfigFinding {
	seen := make(map[string]bool)
	var result []WebConfigFinding
	for _, f := range findings {
		key := f.FindingID + ":" + f.ConfigFile
		if !seen[key] {
			seen[key] = true
			result = append(result, f)
		}
	}
	return result
}
