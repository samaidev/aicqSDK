/**
 * AICQ SDK — WebSocket module
 * Handles WS connection, reconnection with exponential backoff,
 * graceful disconnect, message deduplication, and event callbacks.
 */
import type { MessageCallback, GroupMessageCallback, StreamChunkCallback, StreamEndCallback, StreamCancelCallback, FriendRequestCallback, PresenceCallback, RawCallback } from "./types";
/**
 * Manages the WebSocket lifecycle: connection, reconnection,
 * message routing, and graceful shutdown.
 */
export declare class WSManager {
    private wsUrl;
    private ws;
    private connected;
    private intentionallyClosed;
    private backoffMs;
    private reconnectTimer;
    private nodeId;
    private tokenProvider;
    private onReconnectCallback;
    private seenMessageIds;
    private messageCallback;
    private groupMessageCallback;
    private streamChunkCallback;
    private streamEndCallback;
    private streamCancelCallback;
    private friendRequestCallback;
    private presenceCallback;
    private rawCallback;
    constructor(wsUrl?: string);
    setNodeId(nodeId: string): void;
    setTokenProvider(provider: () => string | null): void;
    setOnReconnect(callback: () => Promise<void>): void;
    onMessage(cb: MessageCallback): void;
    onGroupMessage(cb: GroupMessageCallback): void;
    onStreamChunk(cb: StreamChunkCallback): void;
    onStreamEnd(cb: StreamEndCallback): void;
    onStreamCancel(cb: StreamCancelCallback): void;
    onFriendRequest(cb: FriendRequestCallback): void;
    onPresence(cb: PresenceCallback): void;
    onRaw(cb: RawCallback): void;
    /**
     * Open a WebSocket connection and authenticate with `online` message.
     */
    connect(): void;
    /**
     * Graceful disconnect: send `offline` message, then close.
     */
    disconnect(): void;
    isConnected(): boolean;
    /**
     * Block the event loop until the WebSocket is disconnected.
     * Returns a Promise that resolves when disconnected.
     */
    listen(): Promise<void>;
    /**
     * Send a JSON message over the WebSocket.
     * @returns true if sent successfully, false if WS not connected
     */
    send(msg: Record<string, unknown>): boolean;
    /**
     * Send the `online` authentication message.
     */
    private sendOnline;
    private handleMessage;
    /**
     * Check if a message ID has already been processed.
     * If the list exceeds DEDUP_MAX, prune to DEDUP_KEEP (most recent).
     */
    private isDuplicate;
    private scheduleReconnect;
    private cancelReconnectTimer;
    /**
     * Full cleanup: disconnect and clear all callbacks.
     */
    close(): void;
}
//# sourceMappingURL=websocket.d.ts.map