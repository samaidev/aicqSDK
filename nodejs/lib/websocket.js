"use strict";
/**
 * AICQ SDK — WebSocket module
 * Handles WS connection, reconnection with exponential backoff,
 * graceful disconnect, message deduplication, and event callbacks.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WSManager = void 0;
const ws_1 = __importDefault(require("ws"));
const DEFAULT_WS_URL = "wss://aicq.me/ws";
const MAX_BACKOFF_MS = 60000;
const INITIAL_BACKOFF_MS = 1000;
const DEDUP_MAX = 1000;
const DEDUP_KEEP = 500;
/**
 * Manages the WebSocket lifecycle: connection, reconnection,
 * message routing, and graceful shutdown.
 */
class WSManager {
    constructor(wsUrl = DEFAULT_WS_URL) {
        this.ws = null;
        this.connected = false;
        this.intentionallyClosed = false;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.reconnectTimer = null;
        this.nodeId = null;
        this.tokenProvider = null;
        this.onReconnectCallback = null;
        // Message deduplication: ordered list of message IDs
        this.seenMessageIds = [];
        // Callbacks
        this.messageCallback = null;
        this.groupMessageCallback = null;
        this.streamChunkCallback = null;
        this.streamEndCallback = null;
        this.streamCancelCallback = null;
        this.friendRequestCallback = null;
        this.presenceCallback = null;
        this.rawCallback = null;
        this.wsUrl = wsUrl;
    }
    // ─── Configuration ───
    setNodeId(nodeId) {
        this.nodeId = nodeId;
    }
    setTokenProvider(provider) {
        this.tokenProvider = provider;
    }
    setOnReconnect(callback) {
        this.onReconnectCallback = callback;
    }
    // ─── Callback Registration ───
    onMessage(cb) {
        this.messageCallback = cb;
    }
    onGroupMessage(cb) {
        this.groupMessageCallback = cb;
    }
    onStreamChunk(cb) {
        this.streamChunkCallback = cb;
    }
    onStreamEnd(cb) {
        this.streamEndCallback = cb;
    }
    onStreamCancel(cb) {
        this.streamCancelCallback = cb;
    }
    onFriendRequest(cb) {
        this.friendRequestCallback = cb;
    }
    onPresence(cb) {
        this.presenceCallback = cb;
    }
    onRaw(cb) {
        this.rawCallback = cb;
    }
    // ─── Connection ───
    /**
     * Open a WebSocket connection and authenticate with `online` message.
     */
    connect() {
        if (this.connected && this.ws?.readyState === ws_1.default.OPEN) {
            return; // already connected
        }
        this.intentionallyClosed = false;
        this.ws = new ws_1.default(this.wsUrl);
        this.ws.on("open", () => {
            this.connected = true;
            this.backoffMs = INITIAL_BACKOFF_MS;
            this.sendOnline();
        });
        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            }
            catch {
                // Ignore non-JSON messages
            }
        });
        this.ws.on("close", (code, reason) => {
            this.connected = false;
            if (!this.intentionallyClosed) {
                this.scheduleReconnect();
            }
        });
        this.ws.on("error", (err) => {
            // Error is followed by close, which triggers reconnect
        });
    }
    /**
     * Graceful disconnect: send `offline` message, then close.
     */
    disconnect() {
        this.intentionallyClosed = true;
        this.cancelReconnectTimer();
        if (this.ws && this.connected) {
            // Send graceful offline before closing
            try {
                const offlineMsg = JSON.stringify({
                    type: "offline",
                    nodeId: this.nodeId ?? "",
                });
                this.ws.send(offlineMsg);
            }
            catch {
                // best effort
            }
        }
        try {
            this.ws?.close(1000, "Client disconnect");
        }
        catch {
            // already closed
        }
        this.ws = null;
        this.connected = false;
    }
    isConnected() {
        return this.connected && this.ws?.readyState === ws_1.default.OPEN;
    }
    /**
     * Block the event loop until the WebSocket is disconnected.
     * Returns a Promise that resolves when disconnected.
     */
    listen() {
        return new Promise((resolve) => {
            const check = () => {
                if (!this.connected) {
                    resolve();
                }
                else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
    // ─── Sending ───
    /**
     * Send a JSON message over the WebSocket.
     * @returns true if sent successfully, false if WS not connected
     */
    send(msg) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            return false;
        }
        try {
            this.ws.send(JSON.stringify(msg));
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Send the `online` authentication message.
     */
    sendOnline() {
        const token = this.tokenProvider?.() ?? "";
        this.send({
            type: "online",
            nodeId: this.nodeId ?? "",
            token,
        });
    }
    // ─── Message Routing ───
    handleMessage(msg) {
        // Always fire raw callback
        this.rawCallback?.(msg);
        const msgType = msg.type;
        // Dedup for message types that carry an ID
        const msgId = msg.id;
        if (msgId && this.isDuplicate(msgId)) {
            return; // skip already-processed message
        }
        switch (msgType) {
            case "online_ack": {
                // Connection authenticated
                break;
            }
            case "message":
            case "private_message": {
                this.messageCallback?.(msg);
                break;
            }
            case "group_message": {
                this.groupMessageCallback?.(msg);
                break;
            }
            case "stream_chunk": {
                this.streamChunkCallback?.(msg);
                break;
            }
            case "stream_end": {
                this.streamEndCallback?.(msg);
                break;
            }
            case "stream_cancel": {
                this.streamCancelCallback?.(msg);
                break;
            }
            case "friend_request": {
                this.friendRequestCallback?.(msg);
                break;
            }
            case "presence": {
                this.presenceCallback?.(msg);
                break;
            }
            case "error": {
                const err = msg;
                console.error(`[AICQ WS Error] ${err.message}`);
                break;
            }
            default: {
                // Unknown type — already dispatched to rawCallback
                break;
            }
        }
    }
    // ─── Dedup ───
    /**
     * Check if a message ID has already been processed.
     * If the list exceeds DEDUP_MAX, prune to DEDUP_KEEP (most recent).
     */
    isDuplicate(id) {
        if (this.seenMessageIds.includes(id)) {
            return true;
        }
        this.seenMessageIds.push(id);
        // Prune if over max
        if (this.seenMessageIds.length > DEDUP_MAX) {
            this.seenMessageIds = this.seenMessageIds.slice(-DEDUP_KEEP);
        }
        return false;
    }
    // ─── Reconnection ───
    scheduleReconnect() {
        if (this.intentionallyClosed)
            return;
        const delay = this.backoffMs;
        console.warn(`[AICQ] WS disconnected — reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(async () => {
            try {
                // Refresh token before reconnecting if a callback is set
                if (this.onReconnectCallback) {
                    await this.onReconnectCallback();
                }
                this.connect();
            }
            catch (err) {
                console.error(`[AICQ] Reconnect preparation failed: ${err}`);
                this.scheduleReconnect();
            }
        }, delay);
        // Exponential backoff: 1s, 2s, 4s, 8s, ... max 60s
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
    cancelReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    // ─── Cleanup ───
    /**
     * Full cleanup: disconnect and clear all callbacks.
     */
    close() {
        this.disconnect();
        this.messageCallback = null;
        this.groupMessageCallback = null;
        this.streamChunkCallback = null;
        this.streamEndCallback = null;
        this.streamCancelCallback = null;
        this.friendRequestCallback = null;
        this.presenceCallback = null;
        this.rawCallback = null;
        this.seenMessageIds = [];
    }
}
exports.WSManager = WSManager;
//# sourceMappingURL=websocket.js.map