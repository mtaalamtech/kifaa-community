//go:build linux

package collector

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// CollectOpenPorts reads open ports from /proc/net/tcp, /proc/net/tcp6,
// /proc/net/udp, and /proc/net/udp6, then maps inodes to PIDs via /proc.
func CollectOpenPorts() []OpenPort {
	inodeToPID := buildInodePIDMap()

	var ports []OpenPort

	for _, entry := range []struct {
		path  string
		proto string
	}{
		{"/proc/net/tcp", "tcp"},
		{"/proc/net/tcp6", "tcp"},
		{"/proc/net/udp", "udp"},
		{"/proc/net/udp6", "udp"},
	} {
		entries, err := parseProcNetFile(entry.path, entry.proto)
		if err != nil {
			continue
		}
		for _, p := range entries {
			pid := inodeToPID[p.inode]
			p.PID = pid
			p.ProcessName = pidToName(pid)
			ports = append(ports, p.OpenPort)
		}
	}

	// Deduplicate by port+proto+bind (multiple /proc/net files may overlap)
	seen := make(map[string]bool)
	var unique []OpenPort
	for _, p := range ports {
		key := fmt.Sprintf("%s:%d:%s", p.Protocol, p.Port, p.BindAddress)
		if !seen[key] {
			seen[key] = true
			unique = append(unique, p)
		}
	}
	return unique
}

type procNetEntry struct {
	OpenPort
	inode uint64
}

// parseProcNetFile parses a /proc/net/tcp[6] or /proc/net/udp[6] file.
// Format: sl  local_address  rem_address  st  tx:rx  tr  tm  retrans  uid  timeout  inode
// local_address is hex "XXXXXXXX:PPPP" (little-endian IPv4) or "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:PPPP" (IPv6)
// st: 0A = LISTEN, 01 = ESTABLISHED, etc.
func parseProcNetFile(path, proto string) ([]procNetEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []procNetEntry
	scanner := bufio.NewScanner(f)
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue // skip header
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}

		localAddr := fields[1] // hex "addr:port"
		stateHex := fields[3]
		inodeStr := fields[9]

		bindAddr, port, err := parseHexAddr(localAddr)
		if err != nil {
			continue
		}

		state := hexStateToString(stateHex)

		// Only include LISTEN ports for TCP (or all for UDP)
		if proto == "tcp" && state != "LISTEN" {
			continue
		}

		inode, _ := strconv.ParseUint(inodeStr, 10, 64)

		entries = append(entries, procNetEntry{
			OpenPort: OpenPort{
				Port:        port,
				Protocol:    proto,
				BindAddress: bindAddr,
				State:       state,
			},
			inode: inode,
		})
	}
	return entries, scanner.Err()
}

// parseHexAddr decodes a "XXXXXXXX:PPPP" hex address into (ip, port).
// IPv4 addresses are 8 hex chars; IPv6 are 32 hex chars.
func parseHexAddr(s string) (addr string, port int, err error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", 0, fmt.Errorf("invalid addr: %s", s)
	}

	portHex := parts[1]
	portVal, err := strconv.ParseInt(portHex, 16, 32)
	if err != nil {
		return "", 0, err
	}
	port = int(portVal)

	hexIP := parts[0]
	switch len(hexIP) {
	case 8: // IPv4 little-endian
		var b [4]byte
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(hexIP[i*2:i*2+2], 16, 8)
			if err != nil {
				return "", 0, err
			}
			b[3-i] = byte(v)
		}
		addr = fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
	case 32: // IPv6 — just show abbreviated form
		if hexIP == "00000000000000000000000000000000" {
			addr = "::"
		} else if hexIP == "00000000000000000000000001000000" {
			addr = "::1"
		} else {
			addr = "[::]" // simplified
		}
	default:
		addr = hexIP
	}

	return addr, port, nil
}

// hexStateToString maps /proc/net/tcp state codes to human-readable names.
func hexStateToString(hex string) string {
	switch strings.ToUpper(hex) {
	case "01":
		return "ESTABLISHED"
	case "02":
		return "SYN_SENT"
	case "03":
		return "SYN_RECV"
	case "04":
		return "FIN_WAIT1"
	case "05":
		return "FIN_WAIT2"
	case "06":
		return "TIME_WAIT"
	case "07":
		return "CLOSE"
	case "08":
		return "CLOSE_WAIT"
	case "09":
		return "LAST_ACK"
	case "0A":
		return "LISTEN"
	case "0B":
		return "CLOSING"
	default:
		return "UNKNOWN"
	}
}

// buildInodePIDMap scans /proc/[pid]/fd symlinks to map socket inodes → PID.
func buildInodePIDMap() map[uint64]int {
	m := make(map[uint64]int)

	dirs, err := filepath.Glob("/proc/[0-9]*/fd/*")
	if err != nil {
		return m
	}

	for _, link := range dirs {
		target, err := os.Readlink(link)
		if err != nil {
			continue
		}
		// Socket links look like "socket:[12345]"
		if !strings.HasPrefix(target, "socket:[") {
			continue
		}
		inodeStr := strings.TrimPrefix(target, "socket:[")
		inodeStr = strings.TrimSuffix(inodeStr, "]")
		inode, err := strconv.ParseUint(inodeStr, 10, 64)
		if err != nil {
			continue
		}

		// Extract PID from path /proc/<pid>/fd/<n>
		parts := strings.Split(link, "/")
		if len(parts) >= 3 {
			pid, err := strconv.Atoi(parts[2])
			if err == nil {
				m[inode] = pid
			}
		}
	}
	return m
}

// pidToName returns the process name for a given PID by reading /proc/[pid]/comm.
func pidToName(pid int) string {
	if pid <= 0 {
		return ""
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
