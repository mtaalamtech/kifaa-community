//go:build windows

package collector

import (
	"bufio"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// CollectOpenPorts runs netstat -ano and returns listening ports with process names.
func CollectOpenPorts() []OpenPort {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return nil
	}

	pidNames := buildWindowsPIDNameMap()

	seen := make(map[string]bool)
	var ports []OpenPort

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		// Columns: Proto  Local Address  Foreign Address  State  PID
		// e.g.: TCP    0.0.0.0:445    0.0.0.0:0    LISTENING    4
		//       UDP    0.0.0.0:500    *:*                        664
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		proto := strings.ToLower(fields[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}

		localAddr := fields[1]

		var state string
		var pidStr string

		if proto == "tcp" {
			if len(fields) < 5 {
				continue
			}
			state = strings.ToUpper(fields[3])
			pidStr = fields[4]
			// Only include LISTENING for TCP
			if state != "LISTENING" {
				continue
			}
		} else {
			// UDP: no state column
			if len(fields) < 4 {
				continue
			}
			pidStr = fields[len(fields)-1]
			state = "LISTEN"
		}

		bindAddr, port, err := parseWindowsAddr(localAddr)
		if err != nil || port == 0 {
			continue
		}

		pid, _ := strconv.Atoi(pidStr)

		key := fmt.Sprintf("%s:%d:%s", proto, port, bindAddr)
		if seen[key] {
			continue
		}
		seen[key] = true

		ports = append(ports, OpenPort{
			Port:        port,
			Protocol:    proto,
			PID:         pid,
			ProcessName: pidNames[pid],
			BindAddress: bindAddr,
			State:       state,
		})
	}

	return ports
}

// parseWindowsAddr splits "0.0.0.0:445" or "[::]:445" into (addr, port).
func parseWindowsAddr(s string) (addr string, port int, err error) {
	if strings.HasPrefix(s, "[") {
		// IPv6: [::]:port
		idx := strings.LastIndex(s, "]:")
		if idx < 0 {
			return "", 0, fmt.Errorf("invalid ipv6 addr: %s", s)
		}
		addr = s[:idx+1] // include ']'
		portStr := s[idx+2:]
		port, err = strconv.Atoi(portStr)
		return addr, port, err
	}

	// IPv4
	idx := strings.LastIndex(s, ":")
	if idx < 0 {
		return "", 0, fmt.Errorf("invalid addr: %s", s)
	}
	addr = s[:idx]
	port, err = strconv.Atoi(s[idx+1:])
	return addr, port, err
}

// buildWindowsPIDNameMap uses tasklist to map PID → process name.
func buildWindowsPIDNameMap() map[int]string {
	m := make(map[int]string)

	out, err := exec.Command("tasklist", "/fo", "csv", "/nh").Output()
	if err != nil {
		return m
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// CSV: "process.exe","1234","Console","1","12,345 K"
		parts := strings.Split(line, ",")
		if len(parts) < 2 {
			continue
		}
		name := strings.Trim(parts[0], `"`)
		pidStr := strings.Trim(parts[1], `"`)
		pid, err := strconv.Atoi(pidStr)
		if err == nil {
			// Strip .exe extension for cleanliness
			name = strings.TrimSuffix(name, ".exe")
			m[pid] = name
		}
	}
	return m
}
