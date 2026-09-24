//go:build !windows

package main

import "errors"

func captureScreen() ([]byte, error) {
	return nil, errors.New("screen capture only supported on Windows")
}

func screenDimensions() (int, int) { return 1920, 1080 }
