//go:build windows

package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"syscall"
	"unsafe"
)

var (
	modUser32   = syscall.NewLazyDLL("user32.dll")
	modGdi32    = syscall.NewLazyDLL("gdi32.dll")
	modKernel32 = syscall.NewLazyDLL("kernel32.dll")

	procGetSystemMetrics         = modUser32.NewProc("GetSystemMetrics")
	procGetDC                    = modUser32.NewProc("GetDC")
	procReleaseDC                = modUser32.NewProc("ReleaseDC")
	procCreateCompatibleDC       = modGdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap   = modGdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject             = modGdi32.NewProc("SelectObject")
	procBitBlt                   = modGdi32.NewProc("BitBlt")
	procGetDIBits                = modGdi32.NewProc("GetDIBits")
	procDeleteObject             = modGdi32.NewProc("DeleteObject")
	procDeleteDC                 = modGdi32.NewProc("DeleteDC")
	procGetCurrentThreadId       = modKernel32.NewProc("GetCurrentThreadId")
	procOpenWindowStation        = modUser32.NewProc("OpenWindowStationW")
	procSetProcessWindowStation  = modUser32.NewProc("SetProcessWindowStation")
	procGetProcessWindowStation  = modUser32.NewProc("GetProcessWindowStation")
	procCloseWindowStation       = modUser32.NewProc("CloseWindowStation")
	procOpenDesktop              = modUser32.NewProc("OpenDesktopW")
	procSetThreadDesktop         = modUser32.NewProc("SetThreadDesktop")
	procGetThreadDesktop         = modUser32.NewProc("GetThreadDesktop")
	procCloseDesktop             = modUser32.NewProc("CloseDesktop")
)

const (
	smCxScreen   = 0
	smCyScreen   = 1
	srcCopy      = 0x00CC0020
	dibRgbColors = 0
	biRgb        = 0
	jpegQuality  = 60
	genericAll   = 0x10000000
	winstAAllAccess = 0x0000037F
)

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type bitmapInfo struct {
	BmiHeader bitmapInfoHeader
	BmiColors [1]uint32
}

func screenDimensions() (w, h int) {
	cx, _, _ := procGetSystemMetrics.Call(smCxScreen)
	cy, _, _ := procGetSystemMetrics.Call(smCyScreen)
	return int(cx), int(cy)
}

// switchToInteractiveDesktop attempts to switch the current thread to the
// interactive user's desktop (WinSta0\Default).  When running as a Windows
// service in Session 0, GetDC(NULL) captures the invisible Session-0 desktop.
// By switching to WinSta0\Default we capture what the logged-in user sees.
// Returns a restore function; always call it (even on failure).
func switchToInteractiveDesktop() func() {
	// Save current window station and desktop so we can restore them.
	oldWinSta, _, _ := procGetProcessWindowStation.Call()
	threadId, _, _ := procGetCurrentThreadId.Call()
	oldDesktop, _, _ := procGetThreadDesktop.Call(threadId)

	// Open WinSta0 — the interactive window station used by logged-in users.
	winsName, _ := syscall.UTF16PtrFromString("WinSta0")
	newWinSta, _, _ := procOpenWindowStation.Call(
		uintptr(unsafe.Pointer(winsName)),
		0,               // fInherit
		winstAAllAccess, // dwDesiredAccess
	)
	if newWinSta == 0 {
		return func() {}
	}
	procSetProcessWindowStation.Call(newWinSta)

	// Now open the Default desktop on WinSta0 (the user's visible desktop).
	deskName, _ := syscall.UTF16PtrFromString("Default")
	newDesktop, _, _ := procOpenDesktop.Call(
		uintptr(unsafe.Pointer(deskName)),
		0,          // dwFlags
		0,          // fInherit
		genericAll, // dwDesiredAccess
	)
	if newDesktop != 0 {
		procSetThreadDesktop.Call(newDesktop)
	}

	return func() {
		if newDesktop != 0 {
			if oldDesktop != 0 {
				procSetThreadDesktop.Call(oldDesktop)
			}
			procCloseDesktop.Call(newDesktop)
		}
		if oldWinSta != 0 {
			procSetProcessWindowStation.Call(oldWinSta)
		}
		procCloseWindowStation.Call(newWinSta)
	}
}

func captureScreen() ([]byte, error) {
	// Switch to the interactive desktop so we capture the user's screen.
	restore := switchToInteractiveDesktop()
	defer restore()

	width, height := screenDimensions()
	if width == 0 || height == 0 {
		width, height = 1920, 1080
	}

	hScreen, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, hScreen)

	hMem, _, _ := procCreateCompatibleDC.Call(hScreen)
	defer procDeleteDC.Call(hMem)

	hBmp, _, _ := procCreateCompatibleBitmap.Call(hScreen, uintptr(width), uintptr(height))
	defer procDeleteObject.Call(hBmp)

	procSelectObject.Call(hMem, hBmp)
	procBitBlt.Call(hMem, 0, 0, uintptr(width), uintptr(height),
		hScreen, 0, 0, srcCopy)

	bi := bitmapInfo{}
	bi.BmiHeader.BiSize = uint32(unsafe.Sizeof(bi.BmiHeader))
	bi.BmiHeader.BiWidth = int32(width)
	bi.BmiHeader.BiHeight = -int32(height) // negative = top-down
	bi.BmiHeader.BiPlanes = 1
	bi.BmiHeader.BiBitCount = 32
	bi.BmiHeader.BiCompression = biRgb

	pixels := make([]byte, width*height*4)
	procGetDIBits.Call(
		hMem, hBmp, 0, uintptr(height),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&bi)),
		dibRgbColors,
	)

	// GDI returns BGRA — convert to RGBA for Go's image package
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < len(pixels); i += 4 {
		img.Pix[i+0] = pixels[i+2] // R
		img.Pix[i+1] = pixels[i+1] // G
		img.Pix[i+2] = pixels[i+0] // B
		img.Pix[i+3] = 0xFF        // A
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
