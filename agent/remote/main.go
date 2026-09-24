package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// InputEvent is sent from the browser (via server) to the helper.
type InputEvent struct {
	Type   string `json:"type"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Button string `json:"button"`
	Key    string `json:"key"`
	Delta  int    `json:"delta"`
	// Canvas dimensions from the browser — used to map click coordinates to screen coords
	W int `json:"w"`
	H int `json:"h"`
}

func main() {
	serverURL := flag.String("server", "", "Kifaa server URL (e.g. https://kifaa.kenyanut.com)")
	token := flag.String("token", "", "Session token")
	flag.Parse()

	if *serverURL == "" || *token == "" {
		log.Fatal("--server and --token are required")
	}

	// Convert http(s) → ws(s)
	wsBase := *serverURL
	if strings.HasPrefix(wsBase, "https://") {
		wsBase = "wss://" + wsBase[8:]
	} else if strings.HasPrefix(wsBase, "http://") {
		wsBase = "ws://" + wsBase[7:]
	}
	wsURL := wsBase + "/api/v1/remote/sessions/" + *token + "/helper"

	dialer := websocket.Dialer{
		TLSClientConfig:  &tls.Config{InsecureSkipVerify: true},
		HandshakeTimeout: 15 * time.Second,
		NetDialContext:   nil,
	}
	header := http.Header{}
	conn, _, err := dialer.Dial(wsURL, header)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer conn.Close()
	log.Printf("Connected to session %s", *token)

	done := make(chan struct{})

	// Screen capture loop — send JPEG frames to browser via server
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond) // 20 FPS
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				frame, err := captureScreen()
				if err != nil {
					continue
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					return
				}
			}
		}
	}()

	// Read input events from server → inject into OS
	go func() {
		defer close(done)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var evt InputEvent
			if err := json.Unmarshal(msg, &evt); err != nil {
				continue
			}
			switch evt.Type {
			case "mouse_move", "mouse_down", "mouse_up", "wheel":
				injectMouse(evt)
			case "key_down":
				injectKey(evt, false)
			case "key_up":
				injectKey(evt, true)
			case "quit":
				return
			}
		}
	}()

	// Wait for quit signal or connection close
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-done:
	case <-sig:
	}
	conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}
