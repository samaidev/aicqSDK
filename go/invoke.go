package aicq

// invoke.go — High-level "one-shot" agent invocation (v0.11, "private key = control right" model).
//
// PROBLEM (v0.10 and earlier):
//   InvokeAgentStream(ctx, senderSecKey, target, content, server) required the
//   caller to (a) register a separate "sender" AI agent, (b) make it friends
//   with the target, (c) connect a WebSocket. That's too much ceremony for
//   the common use case: a non-agent program (cron job, monitoring script,
//   CI pipeline) that just holds an AI agent's private key and wants to
//   dispatch work to that agent.
//
// SOLUTION (v0.11):
//   The private key IS the control right. If you hold agent B's private key,
//   you can prove it (via Ed25519 challenge-response) and the server will
//   let you dispatch work to B — no registration, no friends, no WebSocket.
//
//   New flow:
//     1. Caller holds TARGET's secret key (not a separate sender key).
//     2. Caller calls POST /api/v1/auth/challenge {public_key: TARGET_PUB}
//        → gets a challenge nonce.
//     3. Caller signs the challenge with TARGET's private key.
//     4. Caller calls POST /api/v1/agent/invoke-stream {
//          target_public_key, challenge, signature, content, content_type
//        }
//     5. Server verifies the signature, looks up target account_id, sends
//        a message from a built-in "system invoker" account to the target,
//        and opens an SSE stream.
//     6. Target agent (running startLoop elsewhere) receives the message
//        and sends stream_chunk / stream_end back to system_invoker.
//     7. Server's WS handler delivers those chunks to the SSE subscription,
//        which streams them to the caller as SSE events.
//     8. Caller consumes the SSE stream as a Go channel of StreamEvent.
//
// This file is a thin wrapper around the SSE endpoint. The actual server-
// side stream subscription logic lives in server-go/service/stream_invoke.go
// and server-go/handler/invoke_stream.go.

import (
        "bufio"
        "bytes"
        "context"
        "crypto/ed25519"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "strings"
        "time"
)

// ─── Public types (unchanged from v0.10) ──────────────────────────

// AgentMessageContent describes what to send to the target agent.
// In v0.11, only Text and FilePath/FileData/Image are supported via the
// SSE endpoint (file/image upload via the separate /api/v1/chat/upload
// endpoint, then referenced by URL — NOT YET IMPLEMENTED in v0.11; only
// Text works for now).
type AgentMessageContent struct {
        Text     string
        FilePath string
        FileData []byte
        FileName string
        FileMime string
        Image    []byte
        ImageMime string
}

// StreamEvent represents one event from the target agent's output stream.
type StreamEvent struct {
        Type      string      // "chunk" | "end" | "cancel" | "error" | "start" | "warning"
        ChunkType string      // for Type=="chunk"
        Data      interface{} // for Type=="chunk"
        FromID    string      // sender account ID (the target agent)
        Err       error       // for Type=="error"
}

// ─── Public entry point (v0.11) ───────────────────────────────────

// InvokeAgentStream dispatches work to an AI agent and returns its
// streamed output as a Go channel.
//
// v0.11 semantics: "private key = control right". The caller passes the
// TARGET agent's secret key (not a separate sender key). The SDK proves
// ownership via Ed25519 challenge-response, and the server dispatches
// the message on the caller's behalf using a built-in "system invoker"
// account.
//
// Parameters:
//   - ctx:             context for cancellation.
//   - targetSecKeyHex: the TARGET agent's Ed25519 secret key (hex).
//                      Go format: 128 chars (64-byte tweetnacl expanded).
//   - caller:          human-readable name identifying who is dispatching
//                      the task (e.g. "samai_ci", "monitoring_script",
//                      "alice_laptop"). Required — the target agent sees
//                      this in the message "[invoke by <caller>] ...".
//   - content:         what to send. Currently only Text is supported
//                      via the SSE endpoint (file/image upload TBD).
//   - serverURL:       optional; "" → DefaultServer ("https://aicq.me").
//
// Returns:
//   - ch:     receive-only channel of StreamEvent. Closes on end/cancel/error/ctx-done.
//   - cancel: cleanup function (idempotent). ALWAYS defer it.
//   - err:    non-nil = setup failed (bad key, challenge fetch failed,
//             signature failed, HTTP request failed).
//
// The caller does NOT need to:
//   - register an account
//   - be friends with the target
//   - connect a WebSocket
//
// The caller DOES need:
//   - the target agent's private key (proves control right)
//   - the target to be online (running startLoop) to get a stream reply
//     (if target is offline, message is saved but no stream comes back)
//
// Example:
//
//      ch, cancel, err := aicq.InvokeAgentStream(ctx, targetSecKey,
//          "samai_ci",  // caller — who is dispatching this task
//          aicq.AgentMessageContent{Text: "Clean up /tmp logs"}, "")
//      if err != nil { log.Fatal(err) }
//      defer cancel()
//      for ev := range ch {
//          if ev.Type == "chunk" && ev.ChunkType == "text" {
//              fmt.Print(ev.Data.(string))
//          }
//      }
func InvokeAgentStream(
        ctx context.Context,
        targetSecKeyHex string,
        caller string,
        content AgentMessageContent,
        serverURL string,
) (<-chan StreamEvent, func(), error) {
        if targetSecKeyHex == "" {
                return nil, nil, fmt.Errorf("InvokeAgentStream: targetSecKeyHex is empty")
        }
        if caller == "" {
                return nil, nil, fmt.Errorf("InvokeAgentStream: caller is required (identify who is dispatching the task, e.g. 'samai_ci')")
        }
        if content.Text == "" {
                return nil, nil, fmt.Errorf("InvokeAgentStream: v0.11 currently only supports content.Text (file/image upload TBD)")
        }
        if serverURL == "" {
                serverURL = DefaultServer
        }

        // 1. Parse the target's secret key.
        //    Go SDK uses tweetnacl's 64-byte expanded format (128 hex chars).
        //    The server's challenge endpoint expects a 32-byte public key
        //    (64 hex chars). We derive the public key from the secret key.
        secKeyBytes, err := hex.DecodeString(targetSecKeyHex)
        if err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: target secret key is not valid hex: %w", err)
        }
        if len(secKeyBytes) != ed25519.PrivateKeySize {
                return nil, nil, fmt.Errorf("InvokeAgentStream: target secret key is %d bytes, expected %d (ed25519.PrivateKeySize)",
                        len(secKeyBytes), ed25519.PrivateKeySize)
        }
        privKey := ed25519.PrivateKey(secKeyBytes)
        pubKeyHex := hex.EncodeToString(privKey.Public().(ed25519.PublicKey))

        // 2. Fetch a challenge from the server.
        challenge, err := fetchChallenge(ctx, serverURL, pubKeyHex)
        if err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: fetch challenge: %w", err)
        }

        // 3. Sign the challenge with the target's private key.
        //    Server expects: ed25519.Sign(secKey, hex-decoded-challenge)
        chalBytes, err := hex.DecodeString(challenge)
        if err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: challenge is not valid hex: %w", err)
        }
        signature := ed25519.Sign(privKey, chalBytes)
        sigHex := hex.EncodeToString(signature)

        // 4. Build the invoke-stream request body.
        reqBody := map[string]interface{}{
                "target_public_key": pubKeyHex,
                "challenge":         challenge,
                "signature":         sigHex,
                "content":           content.Text,
                "content_type":      "text",
                "caller":            caller,
                "timeout_seconds":   600, // 10 min default; ctx can cancel earlier
        }
        jsonBody, _ := json.Marshal(reqBody)

        // 5. POST to /api/v1/agent/invoke-stream. The response is text/event-stream.
        req, err := http.NewRequestWithContext(ctx, "POST",
                serverURL+"/api/v1/agent/invoke-stream", bytes.NewReader(jsonBody))
        if err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: build request: %w", err)
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Accept", "text/event-stream")

        httpClient := &http.Client{Timeout: 0} // no timeout; SSE is long-lived
        resp, err := httpClient.Do(req)
        if err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: HTTP request failed: %w", err)
        }

        // If status is not 200, read the error body and return.
        if resp.StatusCode != http.StatusOK {
                body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
                resp.Body.Close()
                return nil, nil, fmt.Errorf("InvokeAgentStream: server returned HTTP %d: %s",
                        resp.StatusCode, string(body))
        }

        // 6. Set up the channel + SSE reader goroutine.
        ch := make(chan StreamEvent, 64)
        cancel := func() {
                resp.Body.Close()
                // closing the channel is done by the reader goroutine on EOF
        }

        go func() {
                defer close(ch)
                defer resp.Body.Close()
                scanSSE(ctx, resp.Body, ch)
        }()

        return ch, cancel, nil
}

// ─── Helpers ──────────────────────────────────────────────────────

// fetchChallenge calls POST /api/v1/auth/challenge and returns the
// challenge hex string.
func fetchChallenge(ctx context.Context, serverURL, pubKeyHex string) (string, error) {
        body, _ := json.Marshal(map[string]string{"public_key": pubKeyHex})
        req, err := http.NewRequestWithContext(ctx, "POST",
                serverURL+"/api/v1/auth/challenge", bytes.NewReader(body))
        if err != nil {
                return "", err
        }
        req.Header.Set("Content-Type", "application/json")

        resp, err := http.Post(serverURL+"/api/v1/auth/challenge", "application/json", bytes.NewReader(body))
        _ = req
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        if resp.StatusCode != http.StatusOK {
                b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
                return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
        }
        var result struct {
                Challenge string `json:"challenge"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
                return "", fmt.Errorf("decode challenge response: %w", err)
        }
        if result.Challenge == "" {
                return "", fmt.Errorf("server returned empty challenge")
        }
        return result.Challenge, nil
}

// scanSSE reads a text/event-stream from r and pushes StreamEvents to ch.
// It returns when the stream ends (EOF), the context is cancelled, or an
// "end" / "cancel" / "error" event is received.
func scanSSE(ctx context.Context, r io.Reader, ch chan<- StreamEvent) {
        scanner := bufio.NewScanner(r)
        scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // 1MB max line

        var eventType string
        var dataLines []string

        for scanner.Scan() {
                select {
                case <-ctx.Done():
                        return
                default:
                }

                line := scanner.Text()

                if line == "" {
                        // End of event — dispatch if we have one
                        if eventType != "" && len(dataLines) > 0 {
                                data := strings.Join(dataLines, "\n")
                                ev := parseSSEEvent(eventType, data)
                                select {
                                case ch <- ev:
                                case <-ctx.Done():
                                        return
                                }
                                // Terminal events end the stream
                                if ev.Type == "end" || ev.Type == "cancel" || ev.Type == "error" {
                                        return
                                }
                        }
                        eventType = ""
                        dataLines = nil
                        continue
                }

                if strings.HasPrefix(line, "event: ") {
                        eventType = strings.TrimPrefix(line, "event: ")
                } else if strings.HasPrefix(line, "data: ") {
                        dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
                } else if line == "data:" {
                        dataLines = append(dataLines, "")
                }
        }

        if err := scanner.Err(); err != nil {
                select {
                case ch <- StreamEvent{Type: "error", Err: fmt.Errorf("SSE read error: %w", err)}:
                case <-ctx.Done():
                }
        }
}

// parseSSEEvent converts an SSE event type + JSON data string into a StreamEvent.
func parseSSEEvent(eventType, data string) StreamEvent {
        ev := StreamEvent{Type: eventType}
        var m map[string]interface{}
        if err := json.Unmarshal([]byte(data), &m); err == nil {
                if ct, ok := m["chunkType"].(string); ok {
                        ev.ChunkType = ct
                }
                if d, ok := m["data"]; ok {
                        ev.Data = d
                }
                if from, ok := m["from"].(string); ok {
                        ev.FromID = from
                }
                if msg, ok := m["message"].(string); ok && eventType == "error" {
                        ev.Err = fmt.Errorf("%s", msg)
                }
                if eventType == "error" && ev.Err == nil {
                        ev.Err = fmt.Errorf("server error: %s", data)
                }
        } else {
                // Non-JSON data (rare)
                ev.Data = data
        }
        return ev
}

// ─── Compile-time guards ──────────────────────────────────────────
var _ = time.Second
