package collector

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// DBCheckResult holds the outcome of a database plugin health check.
type DBCheckResult struct {
	Status    string `json:"status"`
	Message   string `json:"message"`
	LatencyMs int    `json:"latency_ms"`
}

// RunDBCheck performs a health check against the given database.
// It uses pure Go (no external DB drivers) — TCP handshakes and HTTP endpoints.
func RunDBCheck(dbType, host string, port int, username, password, database string, timeoutSecs int) DBCheckResult {
	if timeoutSecs <= 0 {
		timeoutSecs = 10
	}
	timeout := time.Duration(timeoutSecs) * time.Second
	addr := fmt.Sprintf("%s:%d", host, port)
	t0 := time.Now()

	switch strings.ToLower(dbType) {
	case "redis":
		return checkRedis(addr, password, timeout, t0)
	case "mysql", "mariadb":
		return checkMySQL(addr, timeout, t0)
	case "mongodb":
		return checkMongoDB(addr, timeout, t0)
	case "memcached":
		return checkMemcached(addr, timeout, t0)
	case "elasticsearch":
		return checkHTTPDB(fmt.Sprintf("http://%s/_cluster/health", addr), username, password, "Elasticsearch", timeout, t0)
	case "opensearch":
		return checkHTTPDB(fmt.Sprintf("http://%s/_cluster/health", addr), username, password, "OpenSearch", timeout, t0)
	case "couchdb":
		return checkHTTPDB(fmt.Sprintf("http://%s/_up", addr), username, password, "CouchDB", timeout, t0)
	case "influxdb":
		return checkHTTPDB(fmt.Sprintf("http://%s/health", addr), username, password, "InfluxDB", timeout, t0)
	case "couchbase":
		return checkHTTPDB(fmt.Sprintf("http://%s/pools/default", addr), username, password, "Couchbase", timeout, t0)
	case "hbase":
		return checkHTTPDB(fmt.Sprintf("http://%s/status/cluster", addr), username, password, "HBase", timeout, t0)
	case "postgresql", "mssql", "oracle", "sap_hana", "cassandra", "db2", "sybase", "informix":
		return checkTCPDB(addr, dbType, timeout, t0)
	default:
		return checkTCPDB(addr, dbType, timeout, t0)
	}
}

// ── Redis ─────────────────────────────────────────────────────────────────────

func checkRedis(addr, password string, timeout time.Duration, t0 time.Time) DBCheckResult {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Connection refused: " + err.Error()}
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	// AUTH if password provided
	if password != "" {
		cmd := fmt.Sprintf("*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n", len(password), password)
		if _, err := conn.Write([]byte(cmd)); err != nil {
			return DBCheckResult{Status: "down", Message: "Write error: " + err.Error()}
		}
		buf := make([]byte, 64)
		n, err := conn.Read(buf)
		if err != nil {
			return DBCheckResult{Status: "down", Message: "Read error: " + err.Error()}
		}
		resp := string(buf[:n])
		if strings.HasPrefix(resp, "-ERR") || strings.HasPrefix(resp, "-WRONGPASS") || strings.HasPrefix(resp, "-NOAUTH") {
			return DBCheckResult{
				Status:    "down",
				LatencyMs: int(time.Since(t0).Milliseconds()),
				Message:   "Redis auth failed: " + strings.TrimSpace(resp),
			}
		}
	}

	// PING
	if _, err := conn.Write([]byte("*1\r\n$4\r\nPING\r\n")); err != nil {
		return DBCheckResult{Status: "down", Message: "Write error: " + err.Error()}
	}
	buf := make([]byte, 16)
	n, err := conn.Read(buf)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Read error: " + err.Error()}
	}
	resp := string(buf[:n])
	lat := int(time.Since(t0).Milliseconds())
	if strings.Contains(resp, "PONG") {
		msg := "Redis PONG"
		if password != "" {
			msg = "Redis PONG (auth OK)"
		}
		return DBCheckResult{Status: "up", LatencyMs: lat, Message: msg}
	}
	return DBCheckResult{Status: "down", LatencyMs: lat, Message: "Unexpected response: " + strings.TrimSpace(resp)}
}

// ── MySQL / MariaDB ───────────────────────────────────────────────────────────

func checkMySQL(addr string, timeout time.Duration, t0 time.Time) DBCheckResult {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Connection refused: " + err.Error()}
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	// MySQL sends a 4-byte packet header then a greeting
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return DBCheckResult{Status: "down", Message: "No greeting from MySQL: " + err.Error()}
	}
	pktLen := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	if pktLen <= 0 || pktLen > 65536 {
		return DBCheckResult{Status: "down", Message: "Invalid MySQL packet length"}
	}
	payload := make([]byte, pktLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return DBCheckResult{Status: "down", Message: "Read error: " + err.Error()}
	}

	lat := int(time.Since(t0).Milliseconds())
	// First byte: 0x0a = protocol v10 (standard MySQL/MariaDB), 0xff = error
	if payload[0] == 0xff {
		return DBCheckResult{Status: "down", LatencyMs: lat, Message: "MySQL error response"}
	}
	if payload[0] == 0x0a {
		// Extract server version string (null-terminated after protocol byte)
		version := ""
		for i := 1; i < len(payload) && payload[i] != 0; i++ {
			version += string(payload[i])
		}
		return DBCheckResult{Status: "up", LatencyMs: lat, Message: "MySQL/MariaDB greeting — " + version}
	}
	return DBCheckResult{Status: "up", LatencyMs: lat, Message: "MySQL/MariaDB responding"}
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

func checkMongoDB(addr string, timeout time.Duration, t0 time.Time) DBCheckResult {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Connection refused: " + err.Error()}
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	// Build a minimal OP_MSG with {isMaster: 1}
	// OP_MSG header: messageLength(4) requestID(4) responseTo(4) opCode(4=2013) flagBits(4) kind(1) doc
	doc := buildBSONHello()

	var buf bytes.Buffer
	msgHeader := make([]byte, 20)
	msgLen := int32(20 + 1 + len(doc)) // header + kind byte + doc
	binary.LittleEndian.PutUint32(msgHeader[0:4], uint32(msgLen))
	binary.LittleEndian.PutUint32(msgHeader[4:8], 1)    // requestID
	binary.LittleEndian.PutUint32(msgHeader[8:12], 0)   // responseTo
	binary.LittleEndian.PutUint32(msgHeader[12:16], 2013) // OP_MSG
	binary.LittleEndian.PutUint32(msgHeader[16:20], 0)  // flagBits
	buf.Write(msgHeader)
	buf.WriteByte(0) // kind = 0 (body section)
	buf.Write(doc)

	if _, err := conn.Write(buf.Bytes()); err != nil {
		return DBCheckResult{Status: "down", Message: "Write error: " + err.Error()}
	}

	// Read response header (16 bytes)
	respHeader := make([]byte, 16)
	if _, err := io.ReadFull(conn, respHeader); err != nil {
		return DBCheckResult{Status: "down", Message: "No response from MongoDB: " + err.Error()}
	}
	lat := int(time.Since(t0).Milliseconds())
	respLen := int(binary.LittleEndian.Uint32(respHeader[0:4]))
	opCode := binary.LittleEndian.Uint32(respHeader[12:16])
	if (opCode == 2013 || opCode == 1) && respLen > 16 {
		return DBCheckResult{Status: "up", LatencyMs: lat, Message: "MongoDB responding (isMaster OK)"}
	}
	return DBCheckResult{Status: "up", LatencyMs: lat, Message: "MongoDB port responding"}
}

// buildBSONHello builds a minimal BSON document {hello: 1}
func buildBSONHello() []byte {
	// BSON: int32(total_size) + 0x10("hello"\x00) + int32(1) + 0x00(terminator)
	key := "hello\x00"
	// element: type(1) + key + value
	// type 0x10 = int32
	elem := make([]byte, 1+len(key)+4)
	elem[0] = 0x10 // int32 type
	copy(elem[1:], []byte(key))
	binary.LittleEndian.PutUint32(elem[1+len(key):], 1)

	totalLen := 4 + len(elem) + 1 // int32 size + elem + 0x00 terminator
	doc := make([]byte, totalLen)
	binary.LittleEndian.PutUint32(doc[0:4], uint32(totalLen))
	copy(doc[4:], elem)
	doc[totalLen-1] = 0x00
	return doc
}

// ── Memcached ─────────────────────────────────────────────────────────────────

func checkMemcached(addr string, timeout time.Duration, t0 time.Time) DBCheckResult {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Connection refused: " + err.Error()}
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	if _, err := conn.Write([]byte("version\r\n")); err != nil {
		return DBCheckResult{Status: "down", Message: "Write error: " + err.Error()}
	}
	buf := make([]byte, 64)
	n, err := conn.Read(buf)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Read error: " + err.Error()}
	}
	lat := int(time.Since(t0).Milliseconds())
	resp := strings.TrimSpace(string(buf[:n]))
	if strings.HasPrefix(resp, "VERSION") {
		return DBCheckResult{Status: "up", LatencyMs: lat, Message: "Memcached " + resp}
	}
	return DBCheckResult{Status: "down", LatencyMs: lat, Message: "Unexpected: " + resp}
}

// ── HTTP-based databases ──────────────────────────────────────────────────────

func checkHTTPDB(url, username, password, label string, timeout time.Duration, t0 time.Time) DBCheckResult {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Bad URL: " + err.Error()}
	}
	if username != "" {
		req.SetBasicAuth(username, password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return DBCheckResult{Status: "down", Message: label + " unreachable: " + err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	lat := int(time.Since(t0).Milliseconds())

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		// Try to extract status from JSON response
		var result map[string]interface{}
		if json.Unmarshal(body, &result) == nil {
			if st, ok := result["status"].(string); ok {
				return DBCheckResult{Status: "up", LatencyMs: lat, Message: label + " — status: " + st}
			}
		}
		return DBCheckResult{Status: "up", LatencyMs: lat, Message: fmt.Sprintf("%s OK (HTTP %d)", label, resp.StatusCode)}
	}
	if resp.StatusCode == 401 {
		return DBCheckResult{Status: "down", LatencyMs: lat, Message: label + " authentication failed"}
	}
	return DBCheckResult{Status: "down", LatencyMs: lat, Message: fmt.Sprintf("%s HTTP %d", label, resp.StatusCode)}
}

// ── Generic TCP check ─────────────────────────────────────────────────────────

func checkTCPDB(addr, dbType string, timeout time.Duration, t0 time.Time) DBCheckResult {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return DBCheckResult{Status: "down", Message: "Connection refused: " + err.Error()}
	}
	defer conn.Close()
	lat := int(time.Since(t0).Milliseconds())
	return DBCheckResult{Status: "up", LatencyMs: lat, Message: strings.ToUpper(dbType) + " port reachable"}
}
