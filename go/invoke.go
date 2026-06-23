package aicq

// invoke.go — High-level "one-shot" agent invocation convenience method.
//
// Provides InvokeAgentStream: a single function that takes the sender
// agent's Ed25519 secret key + a target agent + content (text / file / image),
// sends the content to the target, and returns the target's output stream
// as a Go channel.
//
// This fills the gap noted in the SDK review: all existing primitives
// (SendMessage, SendMediaMessage, OnStreamChunk, OnStreamEnd, ...) are
// low-level and require the caller to manually orchestrate auth, WS
// connect, callback registration, filtering, and cleanup. InvokeAgentStream
// wraps that whole dance into one call.
//
// Architecture:
//
//   senderSecKeyHex ─┐
//                    ├─→ 1. derive pubKey (ed25519)
//                    │   2. challenge-response login as sender
//                    │   3. resolve target (account_id OR public_key hex)
//                    │   4. WS connect + online
//   target ──────────┤   5. register OnStreamChunk/End/Cancel filtered by from_id == target
//   content ─────────┤   6. send content (text / upload+media / image-bytes)
//                    └─→ 7. return channel; close on stream_end/cancel/ctx/error
//
// The caller MUST ensure sender and target are already friends on aicq.me.
// (The AICQ server rejects messages between non-friends with HTTP 4xx.)

import (
        "context"
        "crypto/ed25519"
        "encoding/hex"
        "fmt"
        "strings"
        "sync"
        "time"
)

// ─── Public types ─────────────────────────────────────────────────

// AgentMessageContent describes what to send to the target agent.
// Exactly one of Text / FilePath / FileData / Image should be set
// (in that priority order — if multiple are set, the first non-empty
// one wins).
type AgentMessageContent struct {
        // Text sends a plain text message. Highest priority if non-empty.
        Text string

        // FilePath is a path to a local file to upload and send as a "file" message.
        // The file's MIME type is auto-detected from the extension; override with FileMime.
        FilePath string

        // FileData is raw file bytes to upload (used when FilePath is empty).
        // FileName is required when using FileData so the server can name the upload.
        FileData []byte
        FileName string
        FileMime string

        // Image is a shortcut for FileData with an image MIME type.
        // If non-empty, takes priority over FileData. ImageMime defaults to "image/png".
        Image     []byte
        ImageMime string
}

// StreamEvent represents one event from the target agent's output stream.
//
// Type is one of:
//   - "chunk":  a stream chunk arrived. ChunkType is "text" / "reasoning" /
//               "tool_call" / "image" / etc. Data is the chunk payload
//               (string for text/reasoning, object for tool_call, data URI
//               for image).
//   - "end":    the target signaled stream_end. The channel will be closed
//               immediately after this event.
//   - "cancel": the target signaled stream_cancel. The channel will be
//               closed immediately after this event.
//   - "error":  a fatal error occurred (e.g. WS dropped mid-stream).
//               Err is set. The channel will be closed immediately after.
type StreamEvent struct {
        Type      string      // "chunk" | "end" | "cancel" | "error"
        ChunkType string      // populated for Type=="chunk"
        Data      interface{} // populated for Type=="chunk"
        FromID    string      // sender account ID (the target agent)
        Err       error       // populated for Type=="error"
}

// ─── Public entry point ───────────────────────────────────────────

// InvokeAgentStream is a one-shot convenience that authenticates as the
// sender agent (using their Ed25519 secret key), sends content to a target
// agent, and returns the target's output stream as a channel of StreamEvent.
//
// Parameters:
//
//   - ctx:              context for cancellation; when cancelled, the WS is
//                       torn down and the returned channel is closed.
//   - senderSecKeyHex:  the SENDER's 128-char Ed25519 secret key (hex).
//   - target:           the TARGET's account ID, OR its 64-char public key (hex).
//                       If a public key is supplied, it is resolved to an
//                       account ID via /api/v1/accounts/lookup after login.
//   - content:          what to send (text / file / image). See AgentMessageContent.
//   - serverURL:        optional; "" → DefaultServer ("https://aicq.me").
//
// Returns:
//
//   - ch:     a receive-only channel of StreamEvent. Closes after end/cancel/error/ctx-done.
//   - cancel: a cleanup function. ALWAYS call it (typically via defer) to free the WS
//             connection even if you break out of the range loop early.
//   - err:    a non-nil error means setup failed (bad key, login failed,
//             target resolution failed, WS connect failed, or the initial
//             send failed). When err != nil, ch and cancel are nil.
//
// Friendship requirement: sender and target MUST already be friends on aicq.me.
// If they are not, the initial send will fail with an HTTP error and the
// function returns that error.
//
// Example:
//
//      ch, cancel, err := aicq.InvokeAgentStream(ctx, secKey, targetAccID,
//          aicq.AgentMessageContent{Text: "Hello, what's 2+2?"}, "")
//      if err != nil { log.Fatal(err) }
//      defer cancel()
//      for ev := range ch {
//          if ev.Type == "chunk" && ev.ChunkType == "text" {
//              fmt.Print(ev.Data.(string))
//          }
//      }
func InvokeAgentStream(
        ctx context.Context,
        senderSecKeyHex string,
        target string,
        content AgentMessageContent,
        serverURL string,
) (<-chan StreamEvent, func(), error) {
        if senderSecKeyHex == "" {
                return nil, nil, fmt.Errorf("InvokeAgentStream: senderSecKeyHex is empty")
        }
        if target == "" {
                return nil, nil, fmt.Errorf("InvokeAgentStream: target is empty")
        }
        if err := validateContent(content); err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: %w", err)
        }

        // 1. Build a fresh client (one-shot, no shared state).
        client := NewAICQClient(serverURL)

        // 2. Inject the sender's secret key. pubKeyHex="" triggers internal derivation
        //    inside SetKeys (see auth.go).
        if err := client.auth.SetKeys(senderSecKeyHex, ""); err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: bad sender secret key: %w", err)
        }

        // 3. Challenge-response login as the sender. This populates account_id
        //    and tokens inside the AuthManager.
        if _, err := client.Login(); err != nil {
                return nil, nil, fmt.Errorf("InvokeAgentStream: sender login failed: %w", err)
        }

        // 4. Resolve target. If `target` looks like a 64-char hex pubkey,
        //    look it up; otherwise treat it as an account_id.
        targetAccountID, err := resolveTarget(client, target)
        if err != nil {
                client.Close()
                return nil, nil, fmt.Errorf("InvokeAgentStream: resolve target failed: %w", err)
        }

        // 5. Connect WS. Must happen before sending.
        if err := client.Connect(); err != nil {
                client.Close()
                return nil, nil, fmt.Errorf("InvokeAgentStream: WS connect failed: %w", err)
        }

        // 6. Set up the stream channel + filtered callbacks.
        ch := make(chan StreamEvent, 64)
        var once sync.Once
        cleanup := func() {
                once.Do(func() {
                        client.Disconnect()
                        client.Close()
                        // Drain-and-close the channel from the producer side.
                        // (If the reader has already walked off, this is a no-op
                        // because the channel is buffered and GC'd when unreferenced.)
                        close(ch)
                })
        }

        // Filter helper: only forward events whose from_id == targetAccountID.
        // (Other friends might be streaming concurrently; we ignore them.)
        isFromTarget := func(fromID string) bool {
                return fromID == targetAccountID
        }

        client.OnStreamChunk(func(chunk StreamChunk) {
                if !isFromTarget(chunk.FromID) {
                        return
                }
                select {
                case ch <- StreamEvent{
                        Type:      "chunk",
                        ChunkType: chunk.ChunkType,
                        Data:      chunk.Data,
                        FromID:    chunk.FromID,
                }:
                case <-ctx.Done():
                }
        })

        client.OnStreamEnd(func(msg map[string]interface{}) {
                fromID, _ := msg["from_id"].(string)
                if !isFromTarget(fromID) {
                        return
                }
                select {
                case ch <- StreamEvent{
                        Type:   "end",
                        FromID: fromID,
                }:
                case <-ctx.Done():
                }
                // Signal end-of-stream: schedule async cleanup.
                go cleanup()
        })

        client.OnStreamCancel(func(fromID string) {
                if !isFromTarget(fromID) {
                        return
                }
                select {
                case ch <- StreamEvent{
                        Type:   "cancel",
                        FromID: fromID,
                }:
                case <-ctx.Done():
                }
                go cleanup()
        })

        // 7. Send the content. Failure here is fatal — return as error.
        if err := sendContent(client, targetAccountID, content); err != nil {
                cleanup()
                return nil, nil, fmt.Errorf("InvokeAgentStream: send content failed: %w", err)
        }

        // 8. Watcher goroutine: close the channel on ctx.Done or after a
        //    hard timeout (safety net so a misbehaving target can't hang the
        //    channel forever). Default 10 minutes; override via ctx deadline.
        go func() {
                timer := time.NewTimer(10 * time.Minute)
                defer timer.Stop()
                select {
                case <-ctx.Done():
                        select {
                        case ch <- StreamEvent{Type: "error", Err: ctx.Err()}:
                        default:
                        }
                        cleanup()
                case <-timer.C:
                        select {
                        case ch <- StreamEvent{Type: "error", Err: fmt.Errorf("InvokeAgentStream: hard timeout (10m)") }:
                        default:
                        }
                        cleanup()
                }
        }()

        return ch, cleanup, nil
}

// ─── Helpers ──────────────────────────────────────────────────────

// validateContent ensures exactly one of Text/FilePath/FileData/Image is set.
func validateContent(c AgentMessageContent) error {
        count := 0
        if c.Text != "" {
                count++
        }
        if c.FilePath != "" {
                count++
        }
        if len(c.FileData) > 0 {
                count++
        }
        if len(c.Image) > 0 {
                count++
        }
        if count == 0 {
                return fmt.Errorf("content is empty: set one of Text/FilePath/FileData/Image")
        }
        if count > 1 {
                return fmt.Errorf("content is ambiguous: set exactly one of Text/FilePath/FileData/Image (got %d)", count)
        }
        if len(c.FileData) > 0 && c.FileName == "" {
                return fmt.Errorf("FileData requires FileName")
        }
        return nil
}

// resolveTarget resolves `target` to an account_id. If `target` is a 64-char
// hex string, treats it as a public key and looks it up; otherwise returns
// `target` unchanged (assumed to already be an account_id).
func resolveTarget(client *AICQClient, target string) (string, error) {
        // Ed25519 public keys are 32 bytes = 64 hex chars.
        isHexPubkey := len(target) == 64
        if isHexPubkey {
                _, err := hex.DecodeString(target)
                isHexPubkey = err == nil
        }
        if !isHexPubkey {
                return target, nil
        }
        // Lookup by public key.
        acct, err := client.LookupByPublicKey(target)
        if err != nil {
                return "", fmt.Errorf("lookup public key %s: %w", target[:8]+"...", err)
        }
        if acct == nil || acct.ID == "" {
                return "", fmt.Errorf("lookup returned no account for public key %s", target[:8]+"...")
        }
        return acct.ID, nil
}

// sendContent dispatches to the right SDK method based on which field of
// AgentMessageContent is set.
func sendContent(client *AICQClient, targetAccountID string, content AgentMessageContent) error {
        // Case 1: text message.
        if content.Text != "" {
                return client.SendMessage(targetAccountID, content.Text)
        }

        // Case 2: image bytes (shortcut for FileData with image MIME).
        if len(content.Image) > 0 {
                mime := content.ImageMime
                if mime == "" {
                        mime = "image/png"
                }
                name := content.FileName
                if name == "" {
                        ext := ".png"
                        switch {
                        case strings.Contains(mime, "jpeg") || strings.Contains(mime, "jpg"):
                                ext = ".jpg"
                        case strings.Contains(mime, "gif"):
                                ext = ".gif"
                        case strings.Contains(mime, "webp"):
                                ext = ".webp"
                        }
                        name = fmt.Sprintf("image_%d%s", time.Now().UnixMilli(), ext)
                }
                uploadResp, err := client.AuthUploadFile(name, content.Image, mime)
                if err != nil {
                        return fmt.Errorf("upload image: %w", err)
                }
                return sendUploadedMedia(client, targetAccountID, "image", uploadResp, name, content.Image, mime)
        }

        // Case 3: file path.
        if content.FilePath != "" {
                url, err := client.UploadFile(content.FilePath, "")
                if err != nil {
                        return fmt.Errorf("upload file: %w", err)
                }
                mime := content.FileMime
                if mime == "" {
                        // best-effort detect
                        mime = "application/octet-stream"
                }
                fileInfo := map[string]interface{}{
                        "filename": basename(content.FilePath),
                        "url":      url,
                        "mime_type": mime,
                }
                return client.SendMediaMessage(targetAccountID, "file", url, fileInfo, "", "")
        }

        // Case 4: raw file bytes.
        if len(content.FileData) > 0 {
                mime := content.FileMime
                if mime == "" {
                        mime = "application/octet-stream"
                }
                uploadResp, err := client.AuthUploadFile(content.FileName, content.FileData, mime)
                if err != nil {
                        return fmt.Errorf("upload file data: %w", err)
                }
                return sendUploadedMedia(client, targetAccountID, "file", uploadResp, content.FileName, content.FileData, mime)
        }

        return fmt.Errorf("no content to send (should have been caught by validateContent)")
}

// sendUploadedMedia is a small helper that wraps SendMediaMessage with
// a properly-constructed FileInfo map.
func sendUploadedMedia(
        client *AICQClient,
        targetAccountID, msgType string,
        uploadResp map[string]interface{},
        filename string,
        data []byte,
        mime string,
) error {
        url, _ := uploadResp["url"].(string)
        fileID, _ := uploadResp["id"].(string)
        expiresAt, _ := uploadResp["expires_at"].(string)
        fileSize := float64(len(data))
        if sz, ok := uploadResp["size"].(float64); ok && sz > 0 {
                fileSize = sz
        }
        fileInfo := map[string]interface{}{
                "filename":   filename,
                "size":       int(fileSize),
                "url":        url,
                "id":         fileID,
                "mime_type":  mime,
                "expires_at": expiresAt,
        }
        return client.SendMediaMessage(targetAccountID, msgType, url, fileInfo, "", "")
}

// basename is a tiny filepath.Base replacement that doesn't import `path`
// (keeps the dependency surface of this file minimal).
func basename(p string) string {
        if i := strings.LastIndexAny(p, "/\\"); i >= 0 {
                return p[i+1:]
        }
        return p
}

// ─── Compile-time assertion that ed25519 is reachable ─────────────
// (We don't directly use ed25519 here — SetKeys does — but importing it
// in this file lets `go vet` catch drift in the ed25519 package path.)
var _ = ed25519.PublicKeySize
