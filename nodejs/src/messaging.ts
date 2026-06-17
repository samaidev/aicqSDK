/**
 * AICQ SDK — Messaging module
 * Handles private messages, group messages, media, streaming, and file transfer.
 * WS-first: private/group messages go via WebSocket first, REST fallback on WS failure.
 */

import type {
  Message,
  FileInfo,
  Group,
  UploadResponse,
} from "./types";
import { AICQError } from "./errors";

/**
 * Provides messaging operations: private, group, media, streaming, file transfer.
 */
export class MessagingManager {
  private httpGet: (endpoint: string) => Promise<Response>;
  private httpPost: (endpoint: string, body?: string) => Promise<Response>;
  private wsSend: (msg: Record<string, unknown>) => boolean;
  private getCurrentAgentId: () => string | null;
  onAuthRefresh?: () => Promise<boolean>;

  // Track stream cancellations per friend
  private cancelledStreams: Set<string> = new Set();

  constructor(
    httpGet: (endpoint: string) => Promise<Response>,
    httpPost: (endpoint: string, body?: string) => Promise<Response>,
    wsSend: (msg: Record<string, unknown>) => boolean,
    getCurrentAgentId: () => string | null,
  ) {
    this.httpGet = httpGet;
    this.httpPost = httpPost;
    this.wsSend = wsSend;
    this.getCurrentAgentId = getCurrentAgentId;
  }

  // ─── Private Messages ───

  /**
   * Send a private text message. WS-first with REST fallback.
   */
  async sendMessage(friendId: string, content: string): Promise<void> {
    // Try WS first
    const sent = this.wsSend({
      type: "message",
      to: friendId,
      data: content,
    });

    if (!sent) {
      // REST fallback
      await this.sendPrivateMessageREST(friendId, content);
    }
  }

  /**
   * Send a media message. WS-first with REST fallback.
   */
  async sendMediaMessage(
    friendId: string,
    msgType: string,
    mediaUrl?: string,
    fileInfo?: FileInfo,
    content?: string,
    mediaData?: string,
  ): Promise<void> {
    const data = content ?? mediaUrl ?? "";

    // Try WS first
    const sent = this.wsSend({
      type: "message",
      to: friendId,
      data,
      msgType,
      mediaUrl,
      fileInfo,
      mediaData,
    });

    if (!sent) {
      // REST fallback
      const body = JSON.stringify({
        to: friendId,
        data,
        msgType,
        mediaUrl,
        fileInfo,
        content,
        mediaData,
      });
      const res = await this.httpPost("/chat/messages", body);
      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new AICQError(
          `Send media message failed: ${errText}`,
          res.status,
          "/api/v1/chat/messages",
        );
      }
    }
  }

  /**
   * REST fallback for private messages.
   */
  private async sendPrivateMessageREST(friendId: string, content: string): Promise<void> {
    const body = JSON.stringify({ to: friendId, data: content });
    const res = await this.httpPost("/chat/messages", body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Send message (REST) failed: ${errText}`,
        res.status,
        "/api/v1/chat/messages",
      );
    }
  }

  // ─── Group Messages ───

  /**
   * Send a group message. WS-first with REST fallback.
   */
  async sendGroupMessage(groupId: string, content: string): Promise<void> {
    const agentId = this.getCurrentAgentId() ?? "";

    // Try WS first
    const sent = this.wsSend({
      type: "group_message",
      groupId,
      from: agentId,
      content,
    });

    if (!sent) {
      // REST fallback
      const body = JSON.stringify({
        groupId,
        from: agentId,
        content,
      });
      const res = await this.httpPost(`/groups/${groupId}/messages`, body);
      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new AICQError(
          `Send group message failed: ${errText}`,
          res.status,
          `/api/v1/groups/${groupId}/messages`,
        );
      }
    }
  }

  /**
   * Get group messages (REST).
   */
  async getGroupMessages(
    groupId: string,
    limit?: number,
    before?: string,
  ): Promise<Message[]> {
    let endpoint = `/groups/${groupId}/messages`;
    const params: string[] = [];
    if (limit) params.push(`limit=${limit}`);
    if (before) params.push(`before=${encodeURIComponent(before)}`);
    if (params.length > 0) endpoint += `?${params.join("&")}`;

    const res = await this.httpGet(endpoint);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Get group messages failed: ${errText}`,
        res.status,
        `/api/v1/groups/${groupId}/messages`,
      );
    }

    const data = (await res.json()) as Record<string, unknown> | unknown[];
    return Array.isArray(data) ? (data as Message[]) : ((data as Record<string, unknown>).messages as Message[]) ?? [];
  }

  // ─── Streaming ───

  /**
   * Send a stream chunk to a friend via WS.
   */
  sendStreamChunk(friendId: string, chunkType: string, data: unknown): void {
    this.wsSend({
      type: "stream_chunk",
      to: friendId,
      chunkType,
      data,
    });
  }

  /**
   * Signal the end of a stream via WS.
   */
  sendStreamEnd(friendId: string, messageId?: string): void {
    this.wsSend({
      type: "stream_end",
      to: friendId,
      messageId,
    });
    this.cancelledStreams.delete(friendId);
  }

  /**
   * Cancel a stream via WS.
   */
  sendStreamCancel(friendId: string): void {
    this.wsSend({
      type: "stream_cancel",
      to: friendId,
    });
    this.cancelledStreams.add(friendId);
  }

  /**
   * Check if a stream has been cancelled by the recipient.
   */
  isStreamCancelled(friendId: string): boolean {
    return this.cancelledStreams.has(friendId);
  }

  /**
   * Clear the cancelled state for a stream.
   */
  clearStreamCancel(friendId: string): void {
    this.cancelledStreams.delete(friendId);
  }

  // ─── File Transfer ───

  /**
   * Upload a file and return the URL.
   * @param filePath - Local path to the file
   * @param filename - Optional override for the filename
   * @returns URL of the uploaded file
   */
  async uploadFile(filePath: string, filename?: string): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");

    const resolvedName = filename ?? path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer]);

    const formData = new FormData();
    formData.append("file", blob, resolvedName);

    // Use raw fetch for multipart — the httpPost helper only handles JSON
    const apiBase = this.getApiBase();
    const url = `${apiBase}/chat/upload`;

    const res = await fetch(url, {
      method: "POST",
      body: formData,
      headers: this.getAuthHeaders(),
    });

    // Auto-retry on 401 (refresh token then retry)
    if (res.status === 401) {
      const refreshed = await this.onAuthRefresh?.();
      if (refreshed) {
        const retryRes = await fetch(url, {
          method: "POST",
          body: formData,
          headers: this.getAuthHeaders(),
        });
        if (!retryRes.ok) {
          const errText = await retryRes.text().catch(() => "Unknown error");
          throw new AICQError(
            `File upload failed after auth refresh: ${errText}`,
            retryRes.status,
            "/api/v1/chat/upload",
          );
        }
        const retryData = (await retryRes.json()) as UploadResponse;
        return retryData.url;
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `File upload failed: ${errText}`,
        res.status,
        "/api/v1/chat/upload",
      );
    }

    const data = (await res.json()) as UploadResponse;
    return data.url;
  }

  /**
   * Send a P2P file chunk via WS.
   */
  sendFileChunk(
    friendId: string,
    sessionId: string,
    chunkIndex: number,
    chunkData: string,
  ): void {
    this.wsSend({
      type: "file_chunk",
      to: friendId,
      sessionId,
      chunkIndex,
      chunkData,
    });
  }

  // ─── Conversation ───

  /**
   * Get conversation history.
   */
  async getConversation(conversationId: string): Promise<Message[]> {
    const res = await this.httpGet(`/chat/conversation/${conversationId}`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Get conversation failed: ${errText}`,
        res.status,
        `/api/v1/chat/conversation/${conversationId}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown> | unknown[];
    return Array.isArray(data) ? (data as Message[]) : ((data as Record<string, unknown>).messages as Message[]) ?? [];
  }

  /**
   * Mark messages as read.
   */
  async markRead(conversationId: string): Promise<void> {
    const body = JSON.stringify({ conversationId });
    const res = await this.httpPost("/chat/mark-read", body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Mark read failed: ${errText}`,
        res.status,
        "/api/v1/chat/mark-read",
      );
    }
  }

  // ─── Groups ───

  /**
   * List all groups.
   */
  async listGroups(): Promise<Group[]> {
    const res = await this.httpGet("/groups");

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `List groups failed: ${errText}`,
        res.status,
        "/api/v1/groups",
      );
    }

    const data = (await res.json()) as Record<string, unknown> | unknown[];
    return Array.isArray(data) ? (data as Group[]) : ((data as Record<string, unknown>).groups as Group[]) ?? [];
  }

  /**
   * Create a new group.
   */
  async createGroup(name: string, description?: string): Promise<Group> {
    const body = JSON.stringify({ name, description });
    const res = await this.httpPost("/groups", body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Create group failed: ${errText}`,
        res.status,
        "/api/v1/groups",
      );
    }

    return res.json() as Promise<Group>;
  }

  /**
   * Invite a member to a group.
   */
  async inviteGroupMember(groupId: string, accountId: string): Promise<void> {
    const body = JSON.stringify({ accountId });
    const res = await this.httpPost(`/groups/${groupId}/members`, body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Invite group member failed: ${errText}`,
        res.status,
        `/api/v1/groups/${groupId}/members`,
      );
    }
  }

  // ─── Helpers (injected from client) ───

  private apiBaseValue: string = "";
  private authHeadersFn: () => Record<string, string> = () => ({});

  /** @internal */
  setApiBase(base: string): void {
    this.apiBaseValue = base;
  }

  /** @internal */
  setAuthHeadersFn(fn: () => Record<string, string>): void {
    this.authHeadersFn = fn;
  }

  private getApiBase(): string {
    return this.apiBaseValue;
  }

  private getAuthHeaders(): Record<string, string> {
    return this.authHeadersFn();
  }
}
