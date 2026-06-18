package aicq

import (
        "encoding/json"
        "fmt"
        "log"
        "strings"
        "sync"
        "time"

        "github.com/gorilla/websocket"
)

// ─── WebSocket Connection ────────────────────────────────────────
// Handles: connect, disconnect (with graceful "offline" message),
// message loop, callback dispatch, exponential backoff reconnection.
// Fixed: sends "offline" on disconnect.
// Fixed: exponential backoff (1s, 2s, 4s, ... max 60s).
// Fixed: message dedup via DedupTracker.

// WSManager manages the WebSocket connection lifecycle.
type WSManager struct {
        auth      *AuthManager
        server    string
        conn      *websocket.Conn
        writeMu   sync.Mutex     // protects WS writes
        connMu    sync.RWMutex   // protects conn pointer
        connected bool
        stopCh    chan struct{}   // signal to stop the read loop
        doneCh    chan struct{}   // signal that the read loop has exited

        // Callbacks
        onMessage       MessageCallback
        onGroupMessage  GroupMessageCallback
        onStreamChunk   StreamChunkCallback
        onStreamEnd     StreamEndCallback
        onStreamCancel  StreamCancelCallback
        onFriendRequest FriendRequestCallback
        onPresence      PresenceCallback
        onRaw           RawCallback
        onReconnect     func() // fired after a successful reconnect (set via SetOnReconnect)

        // Dedup
        dedup *DedupTracker

        // Reconnection state
        reconnecting bool
        reconnectMu  sync.Mutex
        backoffSecs  int
}

const (
        maxBackoffSecs  = 60
        initialBackoff  = 1
        pingInterval    = 25 * time.Second // WS protocol-level ping (keepalive)
        jsonPingInterval = 30 * time.Second // JSON {"type":"ping"} for server LastPing
)

// newWSManager creates a new WSManager.
func newWSManager(auth *AuthManager, server string, dedup *DedupTracker) *WSManager {
        return &WSManager{
                auth:       auth,
                server:     server,
                stopCh:     make(chan struct{}),
                doneCh:     make(chan struct{}),
                dedup:      dedup,
                backoffSecs: initialBackoff,
        }
}

// ─── Callback Registration ───

// OnMessage registers a callback for incoming private messages.
func (w *WSManager) OnMessage(cb MessageCallback) {
        w.onMessage = cb
}

// OnGroupMessage registers a callback for incoming group messages.
func (w *WSManager) OnGroupMessage(cb GroupMessageCallback) {
        w.onGroupMessage = cb
}

// OnStreamChunk registers a callback for incoming stream chunks.
func (w *WSManager) OnStreamChunk(cb StreamChunkCallback) {
        w.onStreamChunk = cb
}

// OnStreamEnd registers a callback for stream end events.
func (w *WSManager) OnStreamEnd(cb StreamEndCallback) {
        w.onStreamEnd = cb
}

// OnStreamCancel registers a callback for stream cancel events.
func (w *WSManager) OnStreamCancel(cb StreamCancelCallback) {
        w.onStreamCancel = cb
}

// OnFriendRequest registers a callback for friend request events.
func (w *WSManager) OnFriendRequest(cb FriendRequestCallback) {
        w.onFriendRequest = cb
}

// OnPresence registers a callback for presence change events.
func (w *WSManager) OnPresence(cb PresenceCallback) {
        w.onPresence = cb
}

// OnRaw registers a callback that fires for every WS message before type dispatch.
func (w *WSManager) OnRaw(cb RawCallback) {
        w.onRaw = cb
}

// SetOnReconnect registers a callback that fires after a successful
// reconnect (i.e. after the WS connection is re-established and the
// "online" message has been sent).
//
// This is used by integrators (e.g. zagent) to fetch missed messages
// after a transient WS disconnect. The callback fires both for
// auto-reconnects (triggered by readLoop when the connection drops) and
// for explicit ReconnectLoop calls.
func (w *WSManager) SetOnReconnect(cb func()) {
        w.onReconnect = cb
}

// ─── Connection Management ───

// wsURL converts the HTTP server URL to a WebSocket URL.
func (w *WSManager) wsURL() string {
        u := strings.Replace(w.server, "https://", "wss://", 1)
        u = strings.Replace(u, "http://", "ws://", 1)
        return u
}

// IsConnected returns whether the WS connection is currently active.
func (w *WSManager) IsConnected() bool {
        w.connMu.RLock()
        defer w.connMu.RUnlock()
        return w.connected && w.conn != nil
}

// Connect establishes the WebSocket connection and starts the message loop.
// It sends the "online" message and starts ping keepalive.
func (w *WSManager) Connect() error {
        nodeID := w.auth.AccountID()
        token := w.auth.Token()
        if token == "" {
                return NewConnectionError("no access token available", false)
        }

        wsURL := w.wsURL() + "/ws"
        log.Printf("[WS] Connecting to %s ...", wsURL)

        conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
        if err != nil {
                return NewConnectionError(fmt.Sprintf("dial failed: %v", err), true)
        }

        w.connMu.Lock()
        w.conn = conn
        w.connected = true
        w.stopCh = make(chan struct{})
        w.doneCh = make(chan struct{})
        w.connMu.Unlock()

        // Send online message
        if err := w.sendOnline(nodeID, token); err != nil {
                w.connMu.Lock()
                w.conn = nil
                w.connected = false
                w.connMu.Unlock()
                conn.Close()
                return NewConnectionError(fmt.Sprintf("send online failed: %v", err), true)
        }

        log.Printf("[WS] Online! nodeId=%s", nodeID)

        // Reset backoff on successful connection
        w.reconnectMu.Lock()
        w.backoffSecs = initialBackoff
        w.reconnectMu.Unlock()

        // Start ping keepalive (WS protocol-level)
        go w.pingLoop()
        // Start JSON ping loop (required for AICQ server LastPing updates)
        go w.jsonPingLoop()

        // Start read loop
        go w.readLoop()

        return nil
}

// ConnectWithRetry blocks until the WS connection is established, retrying
// with exponential backoff until success or until stopCh is closed.
//
// This mirrors the behavior of zagent's legacy ConnectWS infinite loop:
// the first Connect() may fail (server unreachable, transient network
// issue, expired token), and we want to keep trying rather than give up
// immediately.
//
// On a successful initial connect, this returns nil. The auto-reconnect
// logic in readLoop handles subsequent disconnects.
//
// If a callback is provided via SetOnReconnect, it will fire after the
// first successful connection too — this allows integrators to fetch
// unread messages on startup, not just on reconnects.
func (w *WSManager) ConnectWithRetry() error {
        // If already connected, nothing to do.
        if w.IsConnected() {
                return nil
        }

        w.reconnectMu.Lock()
        w.reconnecting = true
        w.reconnectMu.Unlock()

        defer func() {
                w.reconnectMu.Lock()
                w.reconnecting = false
                w.reconnectMu.Unlock()
        }()

        // First attempt: try Connect() directly. If the token is empty,
        // the caller (AICQClient.Connect) is responsible for calling
        // EnsureAuth first.
        isFirst := true
        for {
                if !isFirst {
                        // Wait with exponential backoff before retrying.
                        w.reconnectMu.Lock()
                        waitSecs := w.backoffSecs
                        w.reconnectMu.Unlock()

                        log.Printf("[WS] Initial connect retry in %ds ...", waitSecs)

                        select {
                        case <-time.After(time.Duration(waitSecs) * time.Second):
                        case <-w.stopCh:
                                return NewConnectionError("connect cancelled", false)
                        }
                }
                isFirst = false

                // Refresh token before each attempt (no-op if token is still valid).
                if err := w.auth.Refresh(); err != nil {
                        log.Printf("[WS] Token refresh failed before connect: %v", err)
                }

                if err := w.Connect(); err != nil {
                        log.Printf("[WS] Connect failed: %v", err)

                        // Increase backoff
                        w.reconnectMu.Lock()
                        if w.backoffSecs == 0 {
                                w.backoffSecs = initialBackoff
                        }
                        w.backoffSecs *= 2
                        if w.backoffSecs > maxBackoffSecs {
                                w.backoffSecs = maxBackoffSecs
                        }
                        w.reconnectMu.Unlock()
                        continue
                }

                // Successful connection.
                // Fire the onReconnect callback on initial connect too, so
                // integrators can fetch unread messages on startup.
                if w.onReconnect != nil {
                        go w.onReconnect()
                }
                return nil
        }
}

// Disconnect gracefully closes the WebSocket connection.
// FIXED: Sends {"type":"offline","nodeId":"..."} before closing.
func (w *WSManager) Disconnect() {
        w.connMu.Lock()
        conn := w.conn
        w.connected = false
        w.connMu.Unlock()

        if conn == nil {
                return
        }

        // Send offline message before closing (graceful disconnect)
        nodeID := w.auth.AccountID()
        offlineMsg := OfflineMessage{
                Type:   "offline",
                NodeID: nodeID,
        }
        if err := w.sendWSJSON(offlineMsg); err != nil {
                log.Printf("[WS] Failed to send offline message: %v", err)
        } else {
                log.Printf("[WS] Sent offline message, nodeId=%s", nodeID)
        }

        // Signal stop
        close(w.stopCh)

        // Close the connection
        conn.WriteMessage(websocket.CloseMessage,
                websocket.FormatCloseMessage(websocket.CloseNormalClosure, "disconnect"))

        // Wait for read loop to exit (with timeout)
        select {
        case <-w.doneCh:
        case <-time.After(3 * time.Second):
                log.Printf("[WS] Read loop exit timed out, forcing close")
        }

        w.connMu.Lock()
        w.conn = nil
        w.connMu.Unlock()

        conn.Close()
        log.Printf("[WS] Disconnected")
}

// ReconnectLoop attempts to reconnect with exponential backoff.
// This should be called in a goroutine. It will keep trying until
// the stopCh is closed or a successful connection is made.
//
// The onReconnect argument is kept for backward compatibility but is
// ignored — the WSManager's registered onReconnect callback (set via
// SetOnReconnect) is always used. This ensures auto-reconnects from
// readLoop fire the same callback as explicit reconnect calls.
func (w *WSManager) ReconnectLoop(onReconnect func()) {
        w.reconnectMu.Lock()
        w.reconnecting = true
        w.reconnectMu.Unlock()

        defer func() {
                w.reconnectMu.Lock()
                w.reconnecting = false
                w.reconnectMu.Unlock()
        }()

        for {
                // Wait with exponential backoff
                w.reconnectMu.Lock()
                waitSecs := w.backoffSecs
                w.reconnectMu.Unlock()

                log.Printf("[WS] Reconnecting in %ds ...", waitSecs)

                select {
                case <-time.After(time.Duration(waitSecs) * time.Second):
                case <-w.stopCh:
                        return
                }

                // Try to refresh token before reconnecting
                if err := w.auth.Refresh(); err != nil {
                        log.Printf("[WS] Token refresh failed before reconnect: %v", err)
                }

                if err := w.Connect(); err != nil {
                        log.Printf("[WS] Reconnect failed: %v", err)

                        // Increase backoff
                        w.reconnectMu.Lock()
                        w.backoffSecs *= 2
                        if w.backoffSecs > maxBackoffSecs {
                                w.backoffSecs = maxBackoffSecs
                        }
                        w.reconnectMu.Unlock()
                        continue
                }

                // Successful reconnection
                log.Printf("[WS] Reconnected successfully")

                // Use the WSManager's registered onReconnect callback
                // (the onReconnect argument is ignored for backward compat).
                if w.onReconnect != nil {
                        go w.onReconnect()
                }
                return
        }
}

// ─── WS Message Sending ───

// sendOnline sends the "online" message via WS.
func (w *WSManager) sendOnline(nodeID, token string) error {
        msg := OnlineMessage{
                Type:   "online",
                NodeID: nodeID,
                Token:  token,
        }
        return w.sendWSJSON(msg)
}

// SendWSJSON sends a JSON message through the WS connection (thread-safe).
func (w *WSManager) sendWSJSON(msg interface{}) error {
        w.connMu.RLock()
        conn := w.conn
        w.connMu.RUnlock()

        if conn == nil {
                return NewConnectionError("no WS connection", true)
        }

        w.writeMu.Lock()
        defer w.writeMu.Unlock()
        return conn.WriteJSON(msg)
}

// SendMessage sends a private message via WS.
func (w *WSManager) SendMessage(to string, data interface{}) error {
        msg := WSOutboundMessage{
                Type: "message",
                To:   to,
                Data: data,
        }
        return w.sendWSJSON(msg)
}

// SendGroupMessage sends a group message via WS.
func (w *WSManager) SendGroupMessage(groupID, from, content, msgType string) error {
        msg := WSGroupMessage{
                Type:    "group_message",
                GroupID: groupID,
                From:    from,
                Content: content,
                MsgType: msgType,
        }
        return w.sendWSJSON(msg)
}

// SendGroupMessageWithMedia sends a group message with media attachment via WS.
func (w *WSManager) SendGroupMessageWithMedia(groupID, from, content, msgType, mediaURL string, fileInfo map[string]interface{}) error {
        msg := map[string]interface{}{
                "type":      "group_message",
                "groupId":   groupID,
                "from":      from,
                "content":   content,
                "msgType":   msgType,
                "media_url": mediaURL,
                "file_info": fileInfo,
        }
        return w.sendWSJSON(msg)
}

// SendStreamChunk sends a stream chunk via WS.
func (w *WSManager) SendStreamChunk(to, chunkType string, data interface{}) error {
        msg := WSStreamChunk{
                Type:      "stream_chunk",
                To:        to,
                ChunkType: chunkType,
                Data:      data,
        }
        return w.sendWSJSON(msg)
}

// SendStreamChunkWithID sends a stream chunk with a message ID for dedup.
func (w *WSManager) SendStreamChunkWithID(to, chunkType string, data interface{}, msgID string) error {
        msg := WSStreamChunk{
                Type:      "stream_chunk",
                To:        to,
                ChunkType: chunkType,
                Data:      data,
                MsgID:     msgID,
        }
        return w.sendWSJSON(msg)
}

// SendStreamEnd signals the end of a stream.
func (w *WSManager) SendStreamEnd(to, msgID string) error {
        msg := WSStreamEnd{
                Type:  "stream_end",
                To:    to,
                MsgID: msgID,
        }
        return w.sendWSJSON(msg)
}

// SendStreamCancel cancels a stream.
func (w *WSManager) SendStreamCancel(to string) error {
        msg := WSStreamCancel{
                Type: "stream_cancel",
                To:   to,
        }
        return w.sendWSJSON(msg)
}

// SendFileChunk sends a file chunk via WS.
func (w *WSManager) SendFileChunk(to, sessionID string, chunkIndex int, chunkData string) error {
        msg := WSFileChunk{
                Type: "file_chunk",
                To:   to,
                Data: &FileChunkData{
                        Type:       "file_chunk_data",
                        SessionID:  sessionID,
                        ChunkIndex: chunkIndex,
                        ChunkData:  chunkData,
                },
        }
        return w.sendWSJSON(msg)
}

// SendEphemeralOnline sends an ephemeral room online message via WS.
func (w *WSManager) SendEphemeralOnline(ephemeralID, roomID, token string) error {
        msg := map[string]interface{}{
                "type":        "ephemeral_online",
                "ephemeralId": ephemeralID,
                "roomId":      roomID,
                "token":       token,
        }
        return w.sendWSJSON(msg)
}

// ─── Internal Loops ───

// pingLoop sends periodic ping messages for keepalive.
func (w *WSManager) pingLoop() {
        ticker := time.NewTicker(pingInterval)
        defer ticker.Stop()

        for {
                select {
                case <-ticker.C:
                        w.connMu.RLock()
                        conn := w.conn
                        w.connMu.RUnlock()
                        if conn == nil {
                                return
                        }
                        w.writeMu.Lock()
                        err := conn.WriteMessage(websocket.PingMessage, nil)
                        w.writeMu.Unlock()
                        if err != nil {
                                log.Printf("[WS] Ping failed: %v", err)
                                return
                        }
                case <-w.stopCh:
                        return
                }
        }
}

// jsonPingLoop sends periodic JSON {"type":"ping"} messages.
//
// This is REQUIRED for AICQ server compatibility: the server's
// PresenceService.cleanupStale() closes connections whose LastPing hasn't
// been updated in 90 seconds. LastPing is ONLY updated when the server
// receives a JSON {"type":"ping"} message (handlePing in
// server-go/handler/ws.go). WS protocol-level pings (PingMessage) do NOT
// update LastPing.
//
// Without this JSON ping, the agent's WS connection is killed by the
// server ~90 seconds after going online, causing the agent to appear
// offline on the AICQ client.
//
// The interval (30s) is well under the 90s cleanup threshold, giving
// ample margin for network latency.
func (w *WSManager) jsonPingLoop() {
        ticker := time.NewTicker(jsonPingInterval)
        defer ticker.Stop()

        for {
                select {
                case <-ticker.C:
                        if !w.IsConnected() {
                                return
                        }
                        msg := map[string]interface{}{"type": "ping"}
                        if err := w.sendWSJSON(msg); err != nil {
                                log.Printf("[WS] JSON ping failed: %v", err)
                                return
                        }
                case <-w.stopCh:
                        return
                }
        }
}

// readLoop reads messages from the WebSocket and dispatches them to callbacks.
// FIXED: message dedup via DedupTracker.
// FIXED: auto-reconnect on unexpected disconnect.
func (w *WSManager) readLoop() {
        defer close(w.doneCh)

        for {
                w.connMu.RLock()
                conn := w.conn
                w.connMu.RUnlock()
                if conn == nil {
                        return
                }

                _, message, err := conn.ReadMessage()
                if err != nil {
                        w.connMu.Lock()
                        wasConnected := w.connected
                        w.connected = false
                        w.connMu.Unlock()
                        log.Printf("[WS] Read error: %v", err)

                        // Auto-reconnect on unexpected disconnect
                        if wasConnected {
                                select {
                                case <-w.stopCh:
                                        // Intentional disconnect, don't reconnect
                                default:
                                        // Unexpected disconnect — trigger reconnect
                                        go w.ReconnectLoop(nil)
                                }
                        }
                        return
                }

                var msg map[string]interface{}
                if err := json.Unmarshal(message, &msg); err != nil {
                        continue
                }

                // Raw callback (fires for every message before type dispatch)
                if w.onRaw != nil {
                        w.onRaw(msg)
                }

                w.dispatchMessage(msg)
        }
}

// dispatchMessage routes a WS message to the appropriate callback.
func (w *WSManager) dispatchMessage(msg map[string]interface{}) {
        msgType, _ := msg["type"].(string)

        switch msgType {
        case "online_ack":
                log.Printf("[WS] Online acknowledged by server")

        case "message", "private_message":
                w.handleMessage(msg)

        case "group_message":
                w.handleGroupMessage(msg)

        case "stream_chunk":
                w.handleStreamChunk(msg)

        case "stream_end":
                w.handleStreamEnd(msg)

        case "stream_cancel":
                w.handleStreamCancel(msg)

        case "friend_request":
                w.handleFriendRequest(msg)

        case "presence":
                w.handlePresence(msg)

        case "pong":
                // keepalive response, ignore

        case "error":
                errMsg, _ := msg["message"].(string)
                log.Printf("[WS] Server error: %s", errMsg)

        default:
                log.Printf("[WS] Unhandled event type '%s'", msgType)
        }
}

func (w *WSManager) handleMessage(msg map[string]interface{}) {
        // Dedup check
        if msgID, ok := msg["id"].(string); ok && msgID != "" {
                if w.dedup.Has(msgID) {
                        return
                }
                w.dedup.Add(msgID)
        }

        if w.onMessage != nil {
                w.onMessage(msg)
        }
}

func (w *WSManager) handleGroupMessage(msg map[string]interface{}) {
        if msgID, ok := msg["id"].(string); ok && msgID != "" {
                if w.dedup.Has(msgID) {
                        return
                }
                w.dedup.Add(msgID)
        }

        if w.onGroupMessage != nil {
                w.onGroupMessage(msg)
        }
}

func (w *WSManager) handleStreamChunk(msg map[string]interface{}) {
        fromID, _ := msg["from"].(string)
        chunkType, _ := msg["chunkType"].(string)
        data := msg["data"]

        chunk := StreamChunk{
                FromID:    fromID,
                ChunkType: chunkType,
                Data:      data,
        }
        if msgID, ok := msg["msg_id"].(string); ok {
                chunk.MsgID = msgID
        }

        if w.onStreamChunk != nil {
                w.onStreamChunk(chunk)
        }
}

func (w *WSManager) handleStreamEnd(msg map[string]interface{}) {
        if w.onStreamEnd != nil {
                w.onStreamEnd(msg)
        }
}

func (w *WSManager) handleStreamCancel(msg map[string]interface{}) {
        fromID, _ := msg["from"].(string)
        if w.onStreamCancel != nil {
                w.onStreamCancel(fromID)
        }
}

func (w *WSManager) handleFriendRequest(msg map[string]interface{}) {
        fromID, _ := msg["from_id"].(string)
        if fromID == "" {
                fromID, _ = msg["from"].(string)
        }
        log.Printf("[WS] Friend request from: %s", fromID)
        if w.onFriendRequest != nil {
                w.onFriendRequest(msg)
        }
}

func (w *WSManager) handlePresence(msg map[string]interface{}) {
        nodeID, _ := msg["nodeId"].(string)
        online, _ := msg["online"].(bool)
        p := Presence{
                NodeID: nodeID,
                Online: online,
        }
        if w.onPresence != nil {
                w.onPresence(p)
        }
}
