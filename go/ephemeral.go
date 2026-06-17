package aicq

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ─── Ephemeral Room Client ───────────────────────────────────────
// HTTP-only client for ephemeral rooms (no WebSocket).
// Implements AICQAgentClient from the spec.

// EphemeralClient is an HTTP-only client for ephemeral rooms.
type EphemeralClient struct {
	Server          string
	PrivateKey      string
	EphemeralID     string
	RoomID          string
	RoomName        string
	LatestTimestamp string
	Members         []map[string]interface{}
	History         []EphemeralChatMessage
	ExpiresAt       string
	mu              sync.Mutex
}

// NewEphemeralClient creates a new EphemeralClient with the given server URL.
func NewEphemeralClient(serverURL string) *EphemeralClient {
	if serverURL == "" {
		serverURL = DefaultServer
	}
	return &EphemeralClient{
		Server: serverURL,
	}
}

// Join joins an ephemeral room using an invite code.
func (e *EphemeralClient) Join(inviteCode string, displayName string, privateKey string) (*EphemeralJoinResponse, error) {
	payload := map[string]string{
		"invite_code":  strings.ToUpper(strings.TrimSpace(inviteCode)),
		"display_name": strings.TrimSpace(displayName),
	}
	if privateKey != "" {
		payload["private_key"] = privateKey
	}

	var resp EphemeralJoinResponse
	if err := httpPost(e.Server+"/api/v1/ephemeral/agent/join", payload, &resp); err != nil {
		return nil, err
	}

	e.mu.Lock()
	e.PrivateKey = resp.PrivateKey
	e.EphemeralID = resp.EphemeralID
	e.RoomID = resp.RoomID
	e.RoomName = resp.RoomName
	e.Members = resp.Members
	e.History = resp.History
	e.ExpiresAt = resp.ExpiresAt
	if len(resp.History) > 0 {
		e.LatestTimestamp = resp.History[len(resp.History)-1].Timestamp
	}
	e.mu.Unlock()

	return &resp, nil
}

// Chat sends a message in the ephemeral room and waits for responses.
func (e *EphemeralClient) Chat(speak bool, content string, waitSeconds int, since string) (*EphemeralChatResponse, error) {
	e.mu.Lock()
	pk := e.PrivateKey
	ts := e.LatestTimestamp
	e.mu.Unlock()

	if pk == "" {
		return nil, fmt.Errorf("not joined yet")
	}
	if since == "" {
		since = ts
	}

	payload := map[string]interface{}{
		"private_key":  pk,
		"speak":        speak,
		"content":      content,
		"wait_seconds": waitSeconds,
		"since":        since,
	}

	url := e.Server + "/api/v1/ephemeral/agent/chat"
	body, _ := json.Marshal(payload)
	timeout := 60 * time.Second
	if waitSeconds > 30 {
		timeout = time.Duration(waitSeconds+30) * time.Second
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response failed: %w", err)
	}

	if resp.StatusCode != 200 {
		body := string(data)
		if len(body) > 200 {
			body = body[:200]
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}

	var chatResp EphemeralChatResponse
	if err := json.Unmarshal(data, &chatResp); err != nil {
		return nil, fmt.Errorf("parse failed: %w", err)
	}

	e.mu.Lock()
	e.Members = chatResp.Members
	if chatResp.LatestTimestamp != "" {
		e.LatestTimestamp = chatResp.LatestTimestamp
	}
	e.mu.Unlock()

	return &chatResp, nil
}

// GetRoomInfo returns current room info.
func (e *EphemeralClient) GetRoomInfo() map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return map[string]interface{}{
		"room_id":      e.RoomID,
		"room_name":    e.RoomName,
		"ephemeral_id": e.EphemeralID,
		"expires_at":   e.ExpiresAt,
		"members":      e.Members,
	}
}

// randRead is a helper for reading random bytes.
func randRead(b []byte) (int, error) {
	return rand.Read(b)
}
