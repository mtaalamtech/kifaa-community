package collector

import (
	"fmt"
	gnet "net"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
)

type MetricPoint struct {
	Name  string                 `json:"name"`
	Value float64                `json:"value"`
	Tags  map[string]interface{} `json:"tags"`
}

type SystemInfo struct {
	Hostname    string `json:"hostname"`
	IPAddress   string `json:"ip_address"`
	MACAddress  string `json:"mac_address"`
	OSType      string `json:"os_type"`
	OSName      string `json:"os_name"`
	OSVersion   string `json:"os_version"`
	OSArch      string `json:"os_arch"`
}

type HardwareData struct {
	CPUModel       string        `json:"cpu_model"`
	CPUCores       int32         `json:"cpu_cores"`
	CPUThreads     int32         `json:"cpu_threads"`
	RAMTotalGB     float64       `json:"ram_total_gb"`
	Disks          []DiskInfo    `json:"disks"`
	NICs           []NICInfo     `json:"nics"`
	DNSServers     []string      `json:"dns_servers,omitempty"`
	DefaultGateway string        `json:"default_gateway,omitempty"`
}

type DiskInfo struct {
	Name       string  `json:"name"`
	SizeGB     float64 `json:"size_gb"`
	FreeGB     float64 `json:"free_gb"`
	Filesystem string  `json:"filesystem"`
}

type NICInfo struct {
	Name   string   `json:"name"`
	MAC    string   `json:"mac"`
	IPs    []string `json:"ips"`
	IsUp   bool     `json:"is_up"`
	Flags  []string `json:"flags,omitempty"`
	MTU    int      `json:"mtu,omitempty"`
}

func GetSystemInfo() (*SystemInfo, error) {
	hostname, _ := os.Hostname()
	hostInfo, _ := host.Info()

	osName := ""
	osVersion := ""
	if hostInfo != nil {
		osVersion = hostInfo.PlatformVersion
		if hostInfo.OS == "windows" {
			osName = windowsFriendlyName(hostInfo.Platform, hostInfo.PlatformFamily, hostInfo.PlatformVersion)
			if osName == "" {
				osName = fmt.Sprintf("%s %s", hostInfo.Platform, hostInfo.PlatformVersion)
			}
		} else {
			osName = linuxFriendlyName(hostInfo.Platform, hostInfo.PlatformVersion)
		}
	}

	ip, mac := getPrimaryInterface()

	osType := runtime.GOOS
	if osType == "darwin" {
		osType = "macos"
	}

	return &SystemInfo{
		Hostname:   hostname,
		IPAddress:  ip,
		MACAddress: mac,
		OSType:     osType,
		OSName:     osName,
		OSVersion:  osVersion,
		OSArch:     runtime.GOARCH,
	}, nil
}

func getPrimaryInterface() (string, string) {
	// Use UDP dial to find the actual outbound interface IP.
	// This avoids picking virtual adapters (VMware, Hyper-V, VPN) over the
	// physical NIC on Windows.
	conn, err := gnet.Dial("udp4", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		localAddr := conn.LocalAddr().(*gnet.UDPAddr)
		ip := localAddr.IP.String()
		// Find the MAC for this IP
		ifaces, _ := gnet.Interfaces()
		for _, iface := range ifaces {
			addrs, _ := iface.Addrs()
			for _, addr := range addrs {
				var ifIP gnet.IP
				switch v := addr.(type) {
				case *gnet.IPNet:
					ifIP = v.IP
				case *gnet.IPAddr:
					ifIP = v.IP
				}
				if ifIP != nil && ifIP.String() == ip {
					return ip, iface.HardwareAddr.String()
				}
			}
		}
		return ip, ""
	}

	// Fallback: iterate interfaces, skip loopback and virtual adapters
	ifaces, err := gnet.Interfaces()
	if err != nil {
		return "", ""
	}
	for _, iface := range ifaces {
		if iface.Flags&gnet.FlagUp == 0 || iface.Flags&gnet.FlagLoopback != 0 {
			continue
		}
		// Skip common virtual adapter name prefixes
		name := strings.ToLower(iface.Name)
		if strings.Contains(name, "vmware") || strings.Contains(name, "virtualbox") ||
			strings.Contains(name, "vethernet") || strings.Contains(name, "loopback") ||
			strings.Contains(name, "isatap") || strings.Contains(name, "teredo") {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			var ip gnet.IP
			switch v := addr.(type) {
			case *gnet.IPNet:
				ip = v.IP
			case *gnet.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			return ip.String(), iface.HardwareAddr.String()
		}
	}
	return "", ""
}

func CollectMetrics() []MetricPoint {
	var points []MetricPoint

	// CPU
	cpuPercents, err := cpu.Percent(1*time.Second, false)
	if err == nil && len(cpuPercents) > 0 {
		points = append(points, MetricPoint{
			Name:  "cpu_percent",
			Value: cpuPercents[0],
			Tags:  map[string]interface{}{},
		})
	}

	// Per-core CPU
	corePercents, err := cpu.Percent(0, true)
	if err == nil {
		for i, p := range corePercents {
			points = append(points, MetricPoint{
				Name:  "cpu_core_percent",
				Value: p,
				Tags:  map[string]interface{}{"core": i},
			})
		}
	}

	// Memory
	vmStat, err := mem.VirtualMemory()
	if err == nil {
		points = append(points,
			MetricPoint{Name: "memory_percent", Value: vmStat.UsedPercent, Tags: map[string]interface{}{}},
			MetricPoint{Name: "memory_used_mb", Value: float64(vmStat.Used) / 1024 / 1024, Tags: map[string]interface{}{}},
			MetricPoint{Name: "memory_total_mb", Value: float64(vmStat.Total) / 1024 / 1024, Tags: map[string]interface{}{}},
			MetricPoint{Name: "memory_available_mb", Value: float64(vmStat.Available) / 1024 / 1024, Tags: map[string]interface{}{}},
		)
	}

	// Swap
	swapStat, err := mem.SwapMemory()
	if err == nil {
		points = append(points,
			MetricPoint{Name: "swap_percent", Value: swapStat.UsedPercent, Tags: map[string]interface{}{}},
			MetricPoint{Name: "swap_used_mb", Value: float64(swapStat.Used) / 1024 / 1024, Tags: map[string]interface{}{}},
		)
	}

	// Disk usage per partition
	partitions, err := disk.Partitions(false)
	if err == nil {
		for _, part := range partitions {
			usage, err := disk.Usage(part.Mountpoint)
			if err != nil {
				continue
			}
			tags := map[string]interface{}{
				"device":     part.Device,
				"mountpoint": part.Mountpoint,
				"fstype":     part.Fstype,
			}
			points = append(points,
				MetricPoint{Name: "disk_percent", Value: usage.UsedPercent, Tags: tags},
				MetricPoint{Name: "disk_used_gb", Value: float64(usage.Used) / 1024 / 1024 / 1024, Tags: tags},
				MetricPoint{Name: "disk_free_gb", Value: float64(usage.Free) / 1024 / 1024 / 1024, Tags: tags},
				MetricPoint{Name: "disk_total_gb", Value: float64(usage.Total) / 1024 / 1024 / 1024, Tags: tags},
			)
		}
	}

	// Network I/O
	netStats, err := psnet.IOCounters(false)
	if err == nil && len(netStats) > 0 {
		points = append(points,
			MetricPoint{Name: "net_bytes_sent", Value: float64(netStats[0].BytesSent), Tags: map[string]interface{}{}},
			MetricPoint{Name: "net_bytes_recv", Value: float64(netStats[0].BytesRecv), Tags: map[string]interface{}{}},
			MetricPoint{Name: "net_packets_sent", Value: float64(netStats[0].PacketsSent), Tags: map[string]interface{}{}},
			MetricPoint{Name: "net_packets_recv", Value: float64(netStats[0].PacketsRecv), Tags: map[string]interface{}{}},
			MetricPoint{Name: "net_errors_in", Value: float64(netStats[0].Errin), Tags: map[string]interface{}{}},
			MetricPoint{Name: "net_errors_out", Value: float64(netStats[0].Errout), Tags: map[string]interface{}{}},
		)
	}

	// Uptime
	uptime, err := host.Uptime()
	if err == nil {
		points = append(points, MetricPoint{Name: "uptime_seconds", Value: float64(uptime), Tags: map[string]interface{}{}})
	}

	return points
}

func CollectHardware() (*HardwareData, error) {
	hw := &HardwareData{}

	// CPU info
	cpuInfos, err := cpu.Info()
	if err == nil && len(cpuInfos) > 0 {
		hw.CPUModel = cpuInfos[0].ModelName
		hw.CPUCores = cpuInfos[0].Cores
		hw.CPUThreads = int32(len(cpuInfos))
	}

	// Memory
	vmStat, err := mem.VirtualMemory()
	if err == nil {
		hw.RAMTotalGB = float64(vmStat.Total) / 1024 / 1024 / 1024
	}

	// Disks
	partitions, err := disk.Partitions(false)
	if err == nil {
		seen := make(map[string]bool)
		for _, part := range partitions {
			if seen[part.Device] {
				continue
			}
			seen[part.Device] = true
			usage, err := disk.Usage(part.Mountpoint)
			if err != nil {
				continue
			}
			hw.Disks = append(hw.Disks, DiskInfo{
				Name:       part.Device,
				SizeGB:     float64(usage.Total) / 1024 / 1024 / 1024,
				FreeGB:     float64(usage.Free) / 1024 / 1024 / 1024,
				Filesystem: part.Fstype,
			})
		}
	}

	// NICs
	ifaces2, err := gnet.Interfaces()
	if err == nil {
		for _, iface := range ifaces2 {
			if strings.HasPrefix(iface.Name, "lo") || iface.Flags&gnet.FlagLoopback != 0 {
				continue
			}
			addrs, _ := iface.Addrs()
			var ips []string
			for _, addr := range addrs {
				ips = append(ips, addr.String())
			}
			isUp := iface.Flags&gnet.FlagUp != 0
			var flags []string
			if iface.Flags&gnet.FlagUp != 0 {
				flags = append(flags, "up")
			}
			if iface.Flags&gnet.FlagBroadcast != 0 {
				flags = append(flags, "broadcast")
			}
			if iface.Flags&gnet.FlagMulticast != 0 {
				flags = append(flags, "multicast")
			}
			if iface.Flags&gnet.FlagPointToPoint != 0 {
				flags = append(flags, "pointtopoint")
			}
			hw.NICs = append(hw.NICs, NICInfo{
				Name:  iface.Name,
				MAC:   iface.HardwareAddr.String(),
				IPs:   ips,
				IsUp:  isUp,
				Flags: flags,
				MTU:   iface.MTU,
			})
		}
	}

	// DNS servers & default gateway
	hw.DNSServers = GetDNSServers()
	hw.DefaultGateway = GetDefaultGateway()

	return hw, nil
}
