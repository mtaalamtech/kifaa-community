//go:build !windows

package main

func injectMouse(_ InputEvent) {}
func injectKey(_ InputEvent, _ bool) {}
