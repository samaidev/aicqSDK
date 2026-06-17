/**
 * AICQ SDK — WebSocket module
 * Handles WS connection, reconnection with exponential backoff,
 * graceful disconnect, message deduplication, and event callbacks.
 */

import WebSocket from "ws";
import type {
  InboundMessage,
  PrivateMessageInbound,
  GroupMessageInbound,
  StreamChunkMessage,
  StreamEndMessage,
  StreamCancelMessage,
  PresenceMessage,
  FriendRequestInbound,
  ErrorMessage,
  OnlineAckMessage,
  MessageCallback,
  GroupMessageCallback,
  StreamChunkCallback,
  StreamEndCallback,
  StreamCancelCallback,
  FriendRequestCallback,
  PresenceCallback,
  RawCallback,
} from "./types";
import { ConnectionError } from "./errors";

const DEFAULT_WS_URL = "wss://aicq.me/ws";
const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const DEDUP_MAX = 1000;
const DEDUP_KEEP = 500;

/**
 * Manages the WebSocket lifecycle: connection, reconnection,
 * message routing, and graceful shutdown.
 */
export class WSManager {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeId: string | null = null;
  private tokenProvider: (() => string | null) | null = null;
  private onReconnectCallback: (() => Promise<void>) | null = null;

  // Message deduplication: ordered list of message IDs
  private seenMessageIds: string[] = [];

  // Callbacks
  private messageCallback: MessageCallback | null = null;
  private groupMessageCallback: GroupMessageCallback | null = null;
  private streamChunkCallback: StreamChunkCallback | null = null;
  private streamEndCallback: StreamEndCallback | null = null;
  private streamCancelCallback: StreamCancelCallback | null = null;
  private friendRequestCallback: FriendRequestCallback | null = null;
  private presenceCallback: PresenceCallback | null = null;
  private rawCallback: RawCallback | null = null;

  constructor(wsUrl: string = DEFAULT_WS_URL) {
    this.wsUrl = wsUrl;
  }

  // ─── Configuration ───

  setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
  }

  setTokenProvider(provider: () => string | null): void {
    this.tokenProvider = provider;
  }

  setOnReconnect(callback: () => Promise<void>): void {
    this.onReconnectCallback = callback;
  }

  // ─── Callback Registration ───

  onMessage(cb: MessageCallback): void {
    this.messageCallback = cb;
  }

  onGroupMessage(cb: GroupMessageCallback): void {
    this.groupMessageCallback = cb;
  }

  onStreamChunk(cb: StreamChunkCallback): void {
    this.streamChunkCallback = cb;
  }

  onStreamEnd(cb: StreamEndCallback): void {
    this.streamEndCallback = cb;
  }

  onStreamCancel(cb: StreamCancelCallback): void {
    this.streamCancelCallback = cb;
  }

  onFriendRequest(cb: FriendRequestCallback): void {
    this.friendRequestCallback = cb;
  }

  onPresence(cb: PresenceCallback): void {
    this.presenceCallback = cb;
  }

  onRaw(cb: RawCallback): void {
    this.rawCallback = cb;
  }

  // ─── Connection ───

  /**
   * Open a WebSocket connection and authenticate with `online` message.
   */
  connect(): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return; // already connected
    }

    this.intentionallyClosed = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.sendOnline();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg: InboundMessage = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore non-JSON messages
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.connected = false;
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      // Error is followed by close, which triggers reconnect
    });
  }

  /**
   * Graceful disconnect: send `offline` message, then close.
   */
  disconnect(): void {
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
      } catch {
        // best effort
      }
    }

    try {
      this.ws?.close(1000, "Client disconnect");
    } catch {
      // already closed
    }

    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Block the event loop until the WebSocket is disconnected.
   * Returns a Promise that resolves when disconnected.
   */
  listen(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.connected) {
          resolve();
        } else {
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
  send(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send the `online` authentication message.
   */
  private sendOnline(): void {
    const token = this.tokenProvider?.() ?? "";
    this.send({
      type: "online",
      nodeId: this.nodeId ?? "",
      token,
    });
  }

  // ─── Message Routing ───

  private handleMessage(msg: InboundMessage): void {
    // Always fire raw callback
    this.rawCallback?.(msg);

    const msgType = msg.type;

    // Dedup for message types that carry an ID
    const msgId = (msg as Record<string, unknown>).id as string | undefined;
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
        this.messageCallback?.(msg as unknown as PrivateMessageInbound);
        break;
      }
      case "group_message": {
        this.groupMessageCallback?.(msg as unknown as GroupMessageInbound);
        break;
      }
      case "stream_chunk": {
        this.streamChunkCallback?.(msg as unknown as StreamChunkMessage);
        break;
      }
      case "stream_end": {
        this.streamEndCallback?.(msg as unknown as StreamEndMessage);
        break;
      }
      case "stream_cancel": {
        this.streamCancelCallback?.(msg as unknown as StreamCancelMessage);
        break;
      }
      case "friend_request": {
        this.friendRequestCallback?.(msg as unknown as FriendRequestInbound);
        break;
      }
      case "presence": {
        this.presenceCallback?.(msg as unknown as PresenceMessage);
        break;
      }
      case "error": {
        const err = msg as unknown as ErrorMessage;
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
  private isDuplicate(id: string): boolean {
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

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;

    const delay = this.backoffMs;
    console.warn(`[AICQ] WS disconnected — reconnecting in ${delay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Refresh token before reconnecting if a callback is set
        if (this.onReconnectCallback) {
          await this.onReconnectCallback();
        }
        this.connect();
      } catch (err) {
        console.error(`[AICQ] Reconnect preparation failed: ${err}`);
        this.scheduleReconnect();
      }
    }, delay);

    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 60s
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Cleanup ───

  /**
   * Full cleanup: disconnect and clear all callbacks.
   */
  close(): void {
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
