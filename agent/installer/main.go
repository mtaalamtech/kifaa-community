//go:build windows

package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// ── Win32 API ────────────────────────────────────────────────────────────────

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	procRegisterClassExW     = user32.NewProc("RegisterClassExW")
	procCreateWindowExW      = user32.NewProc("CreateWindowExW")
	procShowWindow           = user32.NewProc("ShowWindow")
	procUpdateWindow         = user32.NewProc("UpdateWindow")
	procGetMessageW          = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessageW     = user32.NewProc("DispatchMessageW")
	procDefWindowProcW       = user32.NewProc("DefWindowProcW")
	procPostQuitMessage      = user32.NewProc("PostQuitMessage")
	procPostMessageW         = user32.NewProc("PostMessageW")
	procSendMessageW         = user32.NewProc("SendMessageW")
	procSetWindowTextW       = user32.NewProc("SetWindowTextW")
	procGetWindowTextW       = user32.NewProc("GetWindowTextW")
	procGetWindowTextLenW    = user32.NewProc("GetWindowTextLengthW")
	procEnableWindow         = user32.NewProc("EnableWindow")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procLoadCursorW          = user32.NewProc("LoadCursorW")
	procBeginPaint           = user32.NewProc("BeginPaint")
	procEndPaint             = user32.NewProc("EndPaint")
	procFillRect             = user32.NewProc("FillRect")
	procDrawTextW            = user32.NewProc("DrawTextW")
	procAdjustWindowRectEx   = user32.NewProc("AdjustWindowRectEx")
	procCreateSolidBrush     = gdi32.NewProc("CreateSolidBrush")
	procSetTextColor         = gdi32.NewProc("SetTextColor")
	procSetBkColor           = gdi32.NewProc("SetBkColor")
	procSetBkMode            = gdi32.NewProc("SetBkMode")
	procCreateFontW          = gdi32.NewProc("CreateFontW")
	procSelectObject         = gdi32.NewProc("SelectObject")
	procGetModuleHandleW     = kernel32.NewProc("GetModuleHandleW")
	procInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	procIsUserAnAdmin        = shell32.NewProc("IsUserAnAdmin")
	procShellExecuteW        = shell32.NewProc("ShellExecuteW")
)

// Win32 constants
const (
	WS_OVERLAPPED  = 0x00000000
	WS_CAPTION     = 0x00C00000
	WS_SYSMENU     = 0x00080000
	WS_MINIMIZEBOX = 0x00020000
	WS_CHILD       = 0x40000000
	WS_VISIBLE     = 0x10000000
	WS_TABSTOP     = 0x00010000
	WS_DISABLED    = 0x08000000
	WS_VSCROLL     = 0x00200000

	WS_EX_APPWINDOW  = 0x00040000
	WS_EX_CLIENTEDGE = 0x00000200

	WM_DESTROY        = 0x0002
	WM_CLOSE          = 0x0010
	WM_COMMAND        = 0x0111
	WM_PAINT          = 0x000F
	WM_CTLCOLORSTATIC = 0x0138
	WM_CTLCOLOREDIT   = 0x0133
	WM_SETFONT        = 0x0030
	WM_USER           = 0x0400
	WM_APP_REFRESH    = WM_USER + 1

	BS_PUSHBUTTON  = 0x00000000
	ES_LEFT        = 0x0000
	ES_AUTOHSCROLL = 0x0080

	SS_LEFT = 0x00000000

	// Listbox (used for the log area)
	LBS_HASSTRINGS       = 0x0040
	LBS_NOINTEGRALHEIGHT = 0x0100
	LBS_NOSEL            = 0x4000
	LB_ADDSTRING         = 0x0180
	LB_RESETCONTENT      = 0x0184
	LB_GETCOUNT          = 0x018B
	LB_SETTOPINDEX       = 0x0197

	PBS_SMOOTH   = 0x01
	PBM_SETRANGE = 0x0401
	PBM_SETPOS   = 0x0402

	SW_SHOWNORMAL    = 1
	SM_CXSCREEN      = 0
	SM_CYSCREEN      = 1
	MB_ICONWARNING   = 0x00000030
	IDC_ARROW        = 32512
	ICC_PROGRESS_CLASS = 0x00000020

	ID_EDIT_SERVER = 101
	ID_BTN_INSTALL = 103
	ID_BTN_CLOSE   = 104
	ID_PROGRESS    = 105
	ID_LOG         = 106

	TRANSPARENT = 1
)

// ── Desired client area dimensions ───────────────────────────────────────────
//
// All control coordinates are in client-area space (0,0 = top-left of client).
// We use AdjustWindowRectEx to get the total window size that yields exactly
// this client area, avoiding the "buttons hidden behind title bar" problem.
const (
	clientW = 480
	clientH = 460 // enough for header + URL field + log + progress + buttons
)

// Control layout (y values in client area)
const (
	yHeader    = 0   // painted area: 0..84
	yURLLabel  = 96
	yURLEdit   = 116
	yInfoLabel = 156
	yLogLabel  = 176
	yLogEdit   = 196  // log area
	logH       = 160  // height of log edit (ends at yLogEdit+logH = 356)
	yProgress  = 368
	progressH  = 18
	yButtons   = 398
	buttonH    = 40
)

type WNDCLASSEXW struct {
	CbSize, Style             uint32
	LpfnWndProc               uintptr
	CbClsExtra, CbWndExtra    int32
	HInstance, HIcon          uintptr
	HCursor, HbrBackground    uintptr
	LpszMenuName, LpszClassName *uint16
	HIconSm                   uintptr
}

type MSG struct {
	Hwnd           uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Pt             [2]int32
}

type RECT struct{ Left, Top, Right, Bottom int32 }

type PAINTSTRUCT struct {
	Hdc     uintptr
	FErase  uint32
	RcPaint RECT
	_       [36]byte
}

type INITCOMMONCONTROLSEX struct {
	DwSize, DwICC uint32
}

// ── Globals ───────────────────────────────────────────────────────────────────

var (
	hInst        uintptr
	hMainWnd     uintptr
	hwndServer   uintptr
	hwndInstall  uintptr
	hwndClose    uintptr
	hwndProgress uintptr
	hwndLog      uintptr

	hFont     uintptr
	hFontBold uintptr
	hFontSub  uintptr

	brushDark  uintptr
	brushWhite uintptr
	brushLight uintptr
)

func rgb(r, g, b uint32) uintptr { return uintptr(r | (g << 8) | (b << 16)) }

var (
	colorDark  = rgb(0x1e, 0x3a, 0x5f)
	colorLight = rgb(0xf0, 0xf4, 0xf8)
	colorWhite = rgb(0xff, 0xff, 0xff)
	colorSub   = rgb(0x90, 0xb8, 0xdc)
	colorLabel = rgb(0x33, 0x44, 0x55)
)

// ── Thread-safe UI state ──────────────────────────────────────────────────────

var uiMu sync.Mutex
var uiPendingLines []string  // lines not yet appended to the edit control
var uiProgress int
var uiDone = -1 // -1=running, 0=fail, 1=success

// uiLog queues a line for display and wakes the UI thread.
func uiLog(s string) {
	uiMu.Lock()
	uiPendingLines = append(uiPendingLines, s)
	uiMu.Unlock()
	procPostMessageW.Call(hMainWnd, WM_APP_REFRESH, 0, 0)
}

func uiSetProgress(pct int) {
	uiMu.Lock()
	uiProgress = pct
	uiMu.Unlock()
	procPostMessageW.Call(hMainWnd, WM_APP_REFRESH, 0, 0)
}

func uiSetDone(success bool) {
	v := 0
	if success {
		v = 1
	}
	uiMu.Lock()
	uiDone = v
	uiMu.Unlock()
	procPostMessageW.Call(hMainWnd, WM_APP_REFRESH, 0, 0)
}

// ── Win32 helpers ─────────────────────────────────────────────────────────────

func utf16(s string) uintptr {
	p, _ := syscall.UTF16PtrFromString(s)
	return uintptr(unsafe.Pointer(p))
}

func setText(hwnd uintptr, s string) {
	p, _ := syscall.UTF16PtrFromString(s)
	procSetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(p)))
}

func getText(hwnd uintptr) string {
	n, _, _ := procGetWindowTextLenW.Call(hwnd)
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n+2)
	procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), n+1)
	return syscall.UTF16ToString(buf)
}

func setFont(hwnd, font uintptr) {
	procSendMessageW.Call(hwnd, WM_SETFONT, font, 1)
}

func makeFont(height int, bold bool, face string) uintptr {
	weight := uintptr(400)
	if bold {
		weight = 700
	}
	p, _ := syscall.UTF16PtrFromString(face)
	h, _, _ := procCreateFontW.Call(
		uintptr(height), 0, 0, 0, weight, 0, 0, 0,
		1, 0, 0, 5, 0, uintptr(unsafe.Pointer(p)),
	)
	return h
}

// appendLog adds a line to the log listbox and scrolls it into view.
// Using a LISTBOX (LB_ADDSTRING) instead of a multiline EDIT avoids the
// GDI background-erase artefacts that cause text to render overlapping.
func appendLog(line string) {
	p, _ := syscall.UTF16PtrFromString(line)
	idx, _, _ := procSendMessageW.Call(hwndLog, LB_ADDSTRING, 0,
		uintptr(unsafe.Pointer(p)))
	// Scroll so the newest line is visible
	procSendMessageW.Call(hwndLog, LB_SETTOPINDEX, idx, 0)
}

// ── Window procedure ──────────────────────────────────────────────────────────

var wndProcCB = syscall.NewCallback(func(hwnd, msg, wParam, lParam uintptr) uintptr {
	switch msg {

	case WM_PAINT:
		var ps PAINTSTRUCT
		hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

		// Dark header band
		hdr := RECT{0, 0, clientW, 85}
		procFillRect.Call(hdc, uintptr(unsafe.Pointer(&hdr)), brushDark)

		procSetBkMode.Call(hdc, TRANSPARENT)
		procSetTextColor.Call(hdc, colorWhite)
		procSelectObject.Call(hdc, hFontBold)
		tp, _ := syscall.UTF16PtrFromString("KIFAA AGENT SETUP")
		tr := RECT{20, 14, clientW - 20, 52}
		procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(tp)), ^uintptr(0),
			uintptr(unsafe.Pointer(&tr)), 0) // DT_LEFT|DT_TOP

		procSetTextColor.Call(hdc, colorSub)
		procSelectObject.Call(hdc, hFontSub)
		sp, _ := syscall.UTF16PtrFromString("Endpoint Management Platform  \u2022  v1.3.1")
		sr := RECT{20, 53, clientW - 20, 80}
		procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(sp)), ^uintptr(0),
			uintptr(unsafe.Pointer(&sr)), 0)

		procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		return 0

	case WM_CTLCOLORSTATIC:
		hdc := wParam
		procSetBkMode.Call(hdc, TRANSPARENT)
		procSetTextColor.Call(hdc, colorLabel)
		return brushLight

	case WM_CTLCOLOREDIT:
		hdc := wParam
		procSetBkColor.Call(hdc, colorWhite)
		procSetTextColor.Call(hdc, rgb(0x1a, 0x20, 0x2c))
		return brushWhite

	case WM_COMMAND:
		switch wParam & 0xFFFF {
		case ID_BTN_INSTALL:
			startInstall()
		case ID_BTN_CLOSE:
			procPostQuitMessage.Call(0)
		}

	case WM_APP_REFRESH:
		// Drain pending log lines — append only (no full redraw)
		uiMu.Lock()
		lines := uiPendingLines
		uiPendingLines = nil
		pct := uiProgress
		done := uiDone
		uiMu.Unlock()

		for _, line := range lines {
			appendLog(line)
		}

		procSendMessageW.Call(hwndProgress, PBM_SETPOS, uintptr(pct), 0)

		if done >= 0 {
			procEnableWindow.Call(hwndClose, 1)
			if done == 1 {
				setText(hwndInstall, "  \u2713  Installed")
				procEnableWindow.Call(hwndInstall, 0)
			} else {
				setText(hwndInstall, "Retry")
				procEnableWindow.Call(hwndInstall, 1)
			}
		}

	case WM_CLOSE, WM_DESTROY:
		procPostQuitMessage.Call(0)
	}

	ret, _, _ := procDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return ret
})

// ── Build window ──────────────────────────────────────────────────────────────

func addControl(exStyle uintptr, class, text string, style uint32,
	x, y, w, h int, id uintptr, font uintptr) uintptr {
	hw, _, _ := procCreateWindowExW.Call(
		exStyle, utf16(class), utf16(text), uintptr(style),
		uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		hMainWnd, id, hInst, 0,
	)
	if font != 0 {
		setFont(hw, font)
	}
	return hw
}

func createMainWindow() {
	brushDark, _, _  = procCreateSolidBrush.Call(colorDark)
	brushWhite, _, _ = procCreateSolidBrush.Call(colorWhite)
	brushLight, _, _ = procCreateSolidBrush.Call(colorLight)

	hFont     = makeFont(-14, false, "Segoe UI")
	hFontBold = makeFont(-20, true, "Segoe UI")
	hFontSub  = makeFont(-12, false, "Segoe UI")

	// Register window class
	className, _ := syscall.UTF16PtrFromString("KifaaSetup")
	cursor, _, _ := procLoadCursorW.Call(0, IDC_ARROW)
	wc := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		Style:         0x0003,
		LpfnWndProc:  wndProcCB,
		HInstance:    hInst,
		HbrBackground: brushLight,
		LpszClassName: className,
		HCursor:       cursor,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	// Use AdjustWindowRectEx to calculate total window size from desired
	// client area — this accounts for title bar + borders precisely.
	const winStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX
	adjRect := RECT{0, 0, clientW, clientH}
	procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&adjRect)), winStyle, 0, 0)
	winW := int(adjRect.Right - adjRect.Left)
	winH := int(adjRect.Bottom - adjRect.Top)

	// Center on screen
	sw, _, _ := procGetSystemMetrics.Call(SM_CXSCREEN)
	sh, _, _ := procGetSystemMetrics.Call(SM_CYSCREEN)
	wx := int((sw - uintptr(winW)) / 2)
	wy := int((sh - uintptr(winH)) / 2)

	hMainWnd, _, _ = procCreateWindowExW.Call(
		WS_EX_APPWINDOW,
		uintptr(unsafe.Pointer(className)),
		utf16("Kifaa Agent Setup"),
		winStyle,
		uintptr(wx), uintptr(wy), uintptr(winW), uintptr(winH),
		0, 0, hInst, 0,
	)

	const pad = 20
	const innerW = clientW - pad*2 // 440

	// ── Server URL ────────────────────────────────────────────────────
	addControl(0, "STATIC", "Server URL:", WS_CHILD|WS_VISIBLE|SS_LEFT,
		pad, yURLLabel, innerW, 18, 0, hFont)
	hwndServer = addControl(WS_EX_CLIENTEDGE, "EDIT", defaultServer,
		WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_LEFT|ES_AUTOHSCROLL,
		pad, yURLEdit, innerW, 28, ID_EDIT_SERVER, hFont)

	// ── Instruction line ──────────────────────────────────────────────
	addControl(0, "STATIC",
		"Confirm the server address, then click Install Now.",
		WS_CHILD|WS_VISIBLE|SS_LEFT,
		pad, yInfoLabel, innerW, 18, 0, hFont)

	// ── Log label + listbox (clean per-line rendering, no GDI overlap) ──
	addControl(0, "STATIC", "Installation Log:", WS_CHILD|WS_VISIBLE|SS_LEFT,
		pad, yLogLabel, innerW, 18, 0, hFont)
	hwndLog = addControl(WS_EX_CLIENTEDGE, "LISTBOX", "",
		WS_CHILD|WS_VISIBLE|WS_VSCROLL|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT|LBS_NOSEL,
		pad, yLogEdit, innerW, logH, ID_LOG, hFont)

	appendLog("Ready to install. Click 'Install Now' to begin.")

	// ── Progress bar ──────────────────────────────────────────────────
	icc := INITCOMMONCONTROLSEX{
		DwSize: uint32(unsafe.Sizeof(INITCOMMONCONTROLSEX{})),
		DwICC:  ICC_PROGRESS_CLASS,
	}
	procInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))

	hwndProgress = addControl(0, "msctls_progress32", "",
		WS_CHILD|WS_VISIBLE|PBS_SMOOTH,
		pad, yProgress, innerW, progressH, ID_PROGRESS, 0)
	procSendMessageW.Call(hwndProgress, PBM_SETRANGE, 0, uintptr(100<<16))
	procSendMessageW.Call(hwndProgress, PBM_SETPOS, 0, 0)

	// ── Buttons ───────────────────────────────────────────────────────
	btnW := (innerW - pad) / 2 // two buttons with a gap between them
	hwndInstall = addControl(0, "BUTTON", "Install Now",
		WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,
		pad, yButtons, btnW, buttonH, ID_BTN_INSTALL, hFontBold)
	hwndClose = addControl(0, "BUTTON", "Close",
		WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_DISABLED|BS_PUSHBUTTON,
		pad+btnW+pad, yButtons, btnW, buttonH, ID_BTN_CLOSE, hFont)

	procShowWindow.Call(hMainWnd, SW_SHOWNORMAL)
	procUpdateWindow.Call(hMainWnd)
}

// ── Install button handler ────────────────────────────────────────────────────

func startInstall() {
	serverURL := strings.TrimRight(getText(hwndServer), "/")
	if serverURL == "" {
		serverURL = defaultServer
	}

	procEnableWindow.Call(hwndInstall, 0)
	procEnableWindow.Call(hwndClose, 0)

	// Clear the log listbox and reset state
	procSendMessageW.Call(hwndLog, LB_RESETCONTENT, 0, 0)
	uiMu.Lock()
	uiPendingLines = nil
	uiProgress = 0
	uiDone = -1
	uiMu.Unlock()
	procSendMessageW.Call(hwndProgress, PBM_SETPOS, 0, 0)

	go runInstall(serverURL, defaultSecret)
}

// ── Installation logic ────────────────────────────────────────────────────────

var (
	defaultServer = "http://kifaa.kenyanut.com"
	defaultSecret = "KifaaAgent@Register2026!"
	agentVersion  = "1.3.1"
)

type RegisterRequest struct {
	RegistrationSecret string `json:"registration_secret"`
	Hostname           string `json:"hostname"`
	OSType             string `json:"os_type"`
	OSName             string `json:"os_name"`
	OSVersion          string `json:"os_version"`
	OSArch             string `json:"os_arch"`
	AgentVersion       string `json:"agent_version"`
	AgentType          string `json:"agent_type"`
}

type RegisterResponse struct {
	AgentID string `json:"agent_id"`
	APIKey  string `json:"api_key"`
}

type AgentConfig struct {
	ServerURL          string `json:"server_url"`
	AgentID            string `json:"agent_id"`
	APIKey             string `json:"api_key"`
	RegistrationSecret string `json:"registration_secret"`
	HeartbeatInterval  int    `json:"heartbeat_interval_seconds"`
	InventoryInterval  int    `json:"inventory_interval_seconds"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify"`
}

type progressWriter struct {
	w        io.Writer
	total    int64
	written  int64
	basePct  int
	rangePct int
}

func (pw *progressWriter) Write(b []byte) (int, error) {
	n, err := pw.w.Write(b)
	pw.written += int64(n)
	if pw.total > 0 {
		uiSetProgress(pw.basePct + int(pw.written*int64(pw.rangePct)/pw.total))
	}
	return n, err
}

func runInstall(serverURL, secret string) {
	client := &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
		},
	}

	// ── Step 1: Download ──────────────────────────────────────────────
	uiLog("[1/4]  Downloading Kifaa Agent binary...")
	uiSetProgress(3)

	arch := runtime.GOARCH
	binaryName := fmt.Sprintf("kifaa-agent-windows-%s.exe", arch)
	downloadURL := fmt.Sprintf("%s/downloads/%s", serverURL, binaryName)
	uiLog("       " + downloadURL)

	installDir := filepath.Join(os.Getenv("ProgramFiles"), "KifaaAgent")
	if strings.TrimSpace(installDir) == `\KifaaAgent` || installDir == "" {
		installDir = `C:\Program Files\KifaaAgent`
	}
	if err := os.MkdirAll(installDir, 0755); err != nil {
		uiLog("  ERROR: Cannot create directory: " + err.Error())
		uiSetDone(false)
		return
	}

	agentExe := filepath.Join(installDir, "kifaa-agent.exe")

	if serviceExists("KifaaAgent") {
		uiLog("       Stopping existing service for upgrade...")
		stopSvc("KifaaAgent")
	}

	resp, err := client.Get(downloadURL)
	if err != nil {
		uiLog("  ERROR: Download failed: " + err.Error())
		uiLog("         Make sure " + serverURL + " is reachable.")
		uiSetDone(false)
		return
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		uiLog(fmt.Sprintf("  ERROR: Server returned HTTP %d", resp.StatusCode))
		uiSetDone(false)
		return
	}

	f, err := os.Create(agentExe)
	if err != nil {
		resp.Body.Close()
		uiLog("  ERROR: Cannot create file: " + err.Error())
		uiSetDone(false)
		return
	}
	pw := &progressWriter{w: f, total: resp.ContentLength, basePct: 3, rangePct: 22}
	io.Copy(pw, resp.Body)
	resp.Body.Close()
	f.Close()

	uiLog("       Saved to: " + agentExe)
	uiSetProgress(25)

	// ── Step 2: Register ──────────────────────────────────────────────
	uiLog("[2/4]  Registering with server...")
	uiSetProgress(30)

	hostname, _ := os.Hostname()
	_, osVer := getWinVer()

	regReq := RegisterRequest{
		RegistrationSecret: secret,
		Hostname:           hostname,
		OSType:             "windows",
		OSName:             "Windows " + osVer,
		OSVersion:          osVer,
		OSArch:             runtime.GOARCH,
		AgentVersion:       agentVersion,
		AgentType:          "modern",
	}
	regJSON, _ := json.Marshal(regReq)

	regResp, err := client.Post(serverURL+"/api/v1/agents/register",
		"application/json", strings.NewReader(string(regJSON)))
	if err != nil {
		uiLog("  ERROR: Cannot connect to server: " + err.Error())
		uiSetDone(false)
		return
	}
	defer regResp.Body.Close()

	body, _ := io.ReadAll(regResp.Body)
	if regResp.StatusCode != 200 && regResp.StatusCode != 201 {
		var e map[string]interface{}
		json.Unmarshal(body, &e)
		uiLog(fmt.Sprintf("  ERROR: Registration failed (HTTP %d): %v",
			regResp.StatusCode, e["detail"]))
		uiSetDone(false)
		return
	}

	var reg RegisterResponse
	if err := json.Unmarshal(body, &reg); err != nil {
		uiLog("  ERROR: Bad server response: " + err.Error())
		uiSetDone(false)
		return
	}
	uiLog("       Agent ID: " + reg.AgentID)
	uiSetProgress(50)

	configDir := filepath.Join(os.Getenv("ProgramData"), "KifaaAgent")
	os.MkdirAll(configDir, 0755)
	configPath := filepath.Join(configDir, "config.json")
	cfg := AgentConfig{
		ServerURL: serverURL, AgentID: reg.AgentID, APIKey: reg.APIKey,
		RegistrationSecret: secret, HeartbeatInterval: 30, InventoryInterval: 3600,
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		uiLog("  ERROR: Cannot save config: " + err.Error())
		uiSetDone(false)
		return
	}
	uiLog("       Config: " + configPath)
	uiSetProgress(60)

	// ── Step 3: Install service ───────────────────────────────────────
	uiLog("[3/4]  Installing Windows service...")
	uiSetProgress(65)

	if serviceExists("KifaaAgent") {
		stopSvc("KifaaAgent")
		deleteSvc("KifaaAgent")
	}

	binPath := `"` + agentExe + `"`
	if err := createSvc("KifaaAgent", "Kifaa Endpoint Agent",
		"Kifaa endpoint monitoring and management agent", binPath); err != nil {
		uiLog("  ERROR: " + err.Error())
		uiSetDone(false)
		return
	}
	uiLog("       Service created: KifaaAgent (Automatic start)")
	uiSetProgress(80)

	// ── Step 4: Start service ─────────────────────────────────────────
	uiLog("[4/4]  Starting service...")
	uiSetProgress(85)

	startSvc("KifaaAgent")
	time.Sleep(3 * time.Second)

	status := getSvcStatus("KifaaAgent")
	uiSetProgress(95)

	if status == "running" {
		uiSetProgress(100)
		uiLog("")
		uiLog("\u2713  Kifaa Agent installed and running!")
		uiLog("   Dashboard: " + serverURL)
		uiLog("   The agent appears on the dashboard within 30 seconds.")
		uiSetDone(true)
	} else {
		uiLog("  Service status: " + status)
		uiLog("  Check Windows Event Viewer > Windows Logs > Application for details.")
		uiSetDone(false)
	}
}

// ── Service helpers ───────────────────────────────────────────────────────────

func serviceExists(name string) bool {
	return exec.Command("sc.exe", "query", name).Run() == nil
}

func stopSvc(name string) {
	exec.Command("sc.exe", "stop", name).Run()
	time.Sleep(2 * time.Second)
}

func deleteSvc(name string) {
	exec.Command("sc.exe", "delete", name).Run()
	time.Sleep(2 * time.Second)
}

func createSvc(name, displayName, desc, binPath string) error {
	out, err := exec.Command("sc.exe", "create", name,
		"binPath=", binPath,
		"DisplayName=", displayName,
		"start=", "auto",
		"type=", "own",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sc create: %s", strings.TrimSpace(string(out)))
	}
	exec.Command("sc.exe", "description", name, desc).Run()
	exec.Command("sc.exe", "failure", name,
		"reset=", "86400",
		"actions=", "restart/10000/restart/10000/restart/30000").Run()
	return nil
}

func startSvc(name string) {
	exec.Command("sc.exe", "start", name).Run()
}

func getSvcStatus(name string) string {
	out, err := exec.Command("sc.exe", "query", name).Output()
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "STATE") {
			parts := strings.Fields(line)
			if len(parts) >= 4 {
				return strings.ToLower(parts[3])
			}
		}
	}
	return "unknown"
}

func getWinVer() (string, string) {
	out, err := exec.Command("cmd", "/c", "ver").Output()
	if err != nil {
		return "windows", "unknown"
	}
	v := strings.TrimSpace(string(out))
	v = strings.TrimPrefix(v, "Microsoft Windows [Version ")
	v = strings.TrimSuffix(v, "]")
	return "windows", v
}

// ── Admin / UAC ───────────────────────────────────────────────────────────────

func isAdmin() bool {
	ret, _, _ := procIsUserAnAdmin.Call()
	return ret != 0
}

func relaunchAsAdmin() {
	exe, err := os.Executable()
	if err != nil {
		procMessageBoxW.Call(0,
			utf16("Right-click the .exe and choose 'Run as administrator'."),
			utf16("Kifaa Agent Setup — Admin Required"),
			MB_ICONWARNING,
		)
		os.Exit(1)
	}
	procShellExecuteW.Call(0, utf16("runas"), utf16(exe), 0, 0, SW_SHOWNORMAL)
	os.Exit(0)
}

// ── main ──────────────────────────────────────────────────────────────────────

func main() {
	runtime.LockOSThread()

	icc := INITCOMMONCONTROLSEX{
		DwSize: uint32(unsafe.Sizeof(INITCOMMONCONTROLSEX{})),
		DwICC:  0x0000FFFF,
	}
	procInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))

	hInst, _, _ = procGetModuleHandleW.Call(0)

	if !isAdmin() {
		relaunchAsAdmin()
		return
	}

	createMainWindow()

	var msg MSG
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if r == 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}
