//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	procSendInput    = modUser32.NewProc("SendInput")
	procGetSystemMetricsForInput = modUser32.NewProc("GetSystemMetrics")
)

// INPUT type constants
const (
	inputMouse    = 0
	inputKeyboard = 1
)

// Mouse event flags
const (
	mouseMove       = 0x0001
	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800
	mouseAbsolute   = 0x8000
)

// Keyboard event flags
const (
	keyEventfKeyUp   = 0x0002
	keyEventfUnicode = 0x0004
)

// mouseInput mirrors MOUSEINPUT (28 bytes on 64-bit)
type mouseInput struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

// kbdInput mirrors KEYBDINPUT (20 bytes on 64-bit)
type kbdInput struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

// inputUnion is a byte array large enough for either MOUSEINPUT or KEYBDINPUT
// On 64-bit Windows, MOUSEINPUT is the largest at 28 bytes.
type inputUnion [28]byte

// winInput mirrors INPUT (Type + 4-byte pad + 28-byte union = 36 bytes on 64-bit,
// but Windows pads the struct to 40 bytes for alignment). We use unsafe.Sizeof below.
type winInput struct {
	Type    uint32
	_       [4]byte // padding so union aligns to 8-byte boundary (ULONG_PTR size)
	_data   inputUnion
}

func sendMouseInput(mi mouseInput) {
	var inp winInput
	inp.Type = inputMouse
	*(*mouseInput)(unsafe.Pointer(&inp._data)) = mi
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func sendKbdInput(ki kbdInput) {
	var inp winInput
	inp.Type = inputKeyboard
	*(*kbdInput)(unsafe.Pointer(&inp._data)) = ki
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func injectMouse(evt InputEvent) {
	sw, sh := screenDimensions()

	// Map browser canvas coordinates → screen absolute coords (0-65535)
	var absX, absY int32
	if evt.W > 0 && evt.H > 0 {
		absX = int32(evt.X * 65535 / evt.W)
		absY = int32(evt.Y * 65535 / evt.H)
	} else {
		absX = int32(evt.X * 65535 / sw)
		absY = int32(evt.Y * 65535 / sh)
	}

	switch evt.Type {
	case "mouse_move":
		sendMouseInput(mouseInput{
			Dx: absX, Dy: absY,
			DwFlags: mouseMove | mouseAbsolute,
		})
	case "mouse_down":
		var flags uint32
		switch evt.Button {
		case "left":
			flags = mouseLeftDown
		case "right":
			flags = mouseRightDown
		case "middle":
			flags = mouseMiddleDown
		default:
			flags = mouseLeftDown
		}
		sendMouseInput(mouseInput{
			Dx: absX, Dy: absY,
			DwFlags: mouseAbsolute | mouseMove | flags,
		})
	case "mouse_up":
		var flags uint32
		switch evt.Button {
		case "left":
			flags = mouseLeftUp
		case "right":
			flags = mouseRightUp
		case "middle":
			flags = mouseMiddleUp
		default:
			flags = mouseLeftUp
		}
		sendMouseInput(mouseInput{
			Dx: absX, Dy: absY,
			DwFlags: mouseAbsolute | mouseMove | flags,
		})
	case "wheel":
		// delta: positive = scroll up, negative = scroll down
		// Windows WHEEL_DELTA = 120 per notch
		sendMouseInput(mouseInput{
			MouseData: uint32(int32(-evt.Delta) * 120),
			DwFlags:   mouseWheel,
		})
	}
}

// virtualKeyMap maps browser KeyboardEvent.key values to Windows virtual key codes
var virtualKeyMap = map[string]uint16{
	"Backspace":   0x08,
	"Tab":         0x09,
	"Enter":       0x0D,
	"Escape":      0x1B,
	"Space":       0x20,
	" ":           0x20,
	"PageUp":      0x21,
	"PageDown":    0x22,
	"End":         0x23,
	"Home":        0x24,
	"ArrowLeft":   0x25,
	"ArrowUp":     0x26,
	"ArrowRight":  0x27,
	"ArrowDown":   0x28,
	"Insert":      0x2D,
	"Delete":      0x2E,
	"F1":          0x70,
	"F2":          0x71,
	"F3":          0x72,
	"F4":          0x73,
	"F5":          0x74,
	"F6":          0x75,
	"F7":          0x76,
	"F8":          0x77,
	"F9":          0x78,
	"F10":         0x79,
	"F11":         0x7A,
	"F12":         0x7B,
	"Shift":       0x10,
	"Control":     0x11,
	"Alt":         0x12,
	"Meta":        0x5B,
	"CapsLock":    0x14,
	"NumLock":     0x90,
	"ScrollLock":  0x91,
	"PrintScreen": 0x2C,
	"Pause":       0x13,
}

func injectKey(evt InputEvent, keyUp bool) {
	var upFlag uint32
	if keyUp {
		upFlag = keyEventfKeyUp
	}

	key := evt.Key
	if vk, ok := virtualKeyMap[key]; ok {
		// Known virtual key
		sendKbdInput(kbdInput{WVk: vk, DwFlags: upFlag})
		return
	}

	// For printable characters, use Unicode injection (works for any language)
	runes := []rune(key)
	if len(runes) == 1 {
		sendKbdInput(kbdInput{
			WScan:   uint16(runes[0]),
			DwFlags: keyEventfUnicode | upFlag,
		})
	}
}

// stub to satisfy syscall import on non-windows (build tag prevents this file from compiling there)
var _ = syscall.SIGINT
