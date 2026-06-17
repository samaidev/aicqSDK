/**
 * AICQ SDK — Main client class
 * Orchestrates auth, WebSocket, friends, messaging, and ephemeral modules.
 * Implements the full AICQClient interface from SPEC.md.
 */

import { AuthManager } from "./auth";
import { WSManager } from "./websocket";
import { FriendsManager } from "./friends";
import { MessagingManager } from "./messaging";
import type {
  Agent,
  Friend,
  FriendRequestsResponse,
  Group,
  Message,
  FileInfo,
  EphemeralJoinResponse,
  MessageCallback,
  GroupMessageCallback,
  StreamChunkCallback,
  StreamEndCallback,
  StreamCancelCallback,
  FriendRequestCallback,
  PresenceCallback,
  RawCallback,
  AccountInfo,
  OwnerInfo,
  TempNumberInfo,
} from "./types";
import { AICQError, AuthError } from "./errors";

const DEFAULT_SERVER = "https://aicq.me";

/**
 * AICQClient — the main SDK class.
 *
 * Provides the complete AICQ API surface: identity management, authentication,
 * WebSocket messaging, friend operations, streaming, file transfer, groups,
 * ephemeral rooms, and more.
 *
 * Default server: https://aicq.me
 */
export class AICQClient {
  private auth: AuthManager;
  private ws: WSManager;
  private friends: FriendsManager;
  private messaging: MessagingManager;
  private serverUrl: string;
  private apiBase: string;

  constructor(serverUrl: string = DEFAULT_SERVER) {
    this.serverUrl = serverUrl;
    this.apiBase = `${serverUrl}/api/v1`;

    // Initialize auth manager
    this.auth = new AuthManager(serverUrl);

    // Initialize WebSocket manager
    const wsUrl = serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/ws";
    this.ws = new WSManager(wsUrl);
    this.ws.setTokenProvider(() => this.auth.getAccessToken());
    this.ws.setOnReconnect(async () => {
      await this.auth.ensureAuth();
    });

    // Initialize friends manager with HTTP method bindings
    this.friends = new FriendsManager(
      (ep) => this.httpGet(ep),
      (ep, body) => this.httpPost(ep, body),
      (ep) => this.httpDelete(ep),
    );

    // Initialize messaging manager
    this.messaging = new MessagingManager(
      (ep) => this.httpGet(ep),
      (ep, body) => this.httpPost(ep, body),
      (msg) => this.ws.send(msg),
      () => this.auth.getCurrentAgent()?.agentId ?? null,
    );
    this.messaging.setApiBase(this.apiBase);
    this.messaging.setAuthHeadersFn(() => this.buildAuthHeaders());
    this.messaging.onAuthRefresh = async () => {
      try {
        await this.auth.ensureAuth();
        return true;
      } catch {
        return false;
      }
    };
  }

  // ─── Identity & Auth ───

  /**
   * Register a new AI agent on the server.
   */
  async createAgent(name: string): Promise<Agent> {
    return this.auth.createAgent(name);
  }

  /**
   * Load a previously created agent by ID.
   * If agentId is omitted, returns the current agent.
   */
  loadAgent(agentId?: string): Agent | null {
    return this.auth.loadAgent(agentId);
  }

  /**
   * List all locally stored agents.
   */
  listAgents(): Agent[] {
    return this.auth.listAgents();
  }

  /**
   * Set the current agent for subsequent operations.
   */
  setCurrentAgent(agentId: string): boolean {
    return this.auth.setCurrentAgent(agentId);
  }

  /**
   * Login using challenge-response authentication.
   * @returns access_token
   */
  async login(): Promise<string> {
    return this.auth.login();
  }

  /**
   * Refresh the access token.
   */
  async refreshAuth(): Promise<void> {
    return this.auth.refreshAuth();
  }

  /**
   * Ensure authentication: refresh or login as needed.
   */
  async ensureAuth(): Promise<void> {
    return this.auth.ensureAuth();
  }

  // ─── WebSocket ───

  /**
   * Open a WebSocket connection and authenticate.
   */
  connect(): void {
    const agent = this.auth.getCurrentAgent();
    if (agent) {
      this.ws.setNodeId(agent.agentId);
    }
    this.ws.connect();
  }

  /**
   * Gracefully disconnect from WebSocket.
   * Sends `{"type":"offline","nodeId":"..."}` before closing.
   */
  disconnect(): void {
    this.ws.disconnect();
  }

  /**
   * Check if the WebSocket is currently connected.
   */
  isConnected(): boolean {
    return this.ws.isConnected();
  }

  /**
   * Block until the WebSocket is disconnected.
   */
  async listen(): Promise<void> {
    return this.ws.listen();
  }

  // ─── Callbacks ───

  onMessage(cb: MessageCallback): void {
    this.ws.onMessage(cb);
  }

  onGroupMessage(cb: GroupMessageCallback): void {
    this.ws.onGroupMessage(cb);
  }

  onStreamChunk(cb: StreamChunkCallback): void {
    this.ws.onStreamChunk(cb);
  }

  onStreamEnd(cb: StreamEndCallback): void {
    this.ws.onStreamEnd(cb);
  }

  onStreamCancel(cb: StreamCancelCallback): void {
    this.ws.onStreamCancel(cb);
  }

  onFriendRequest(cb: FriendRequestCallback): void {
    this.ws.onFriendRequest(cb);
  }

  onPresence(cb: PresenceCallback): void {
    this.ws.onPresence(cb);
  }

  onRaw(cb: RawCallback): void {
    this.ws.onRaw(cb);
  }

  // ─── Friends ───

  async addFriend(accountId: string, message?: string): Promise<Record<string, unknown>> {
    return this.friends.addFriend(accountId, message);
  }

  async listFriends(): Promise<Friend[]> {
    return this.friends.listFriends();
  }

  async listFriendRequests(): Promise<FriendRequestsResponse> {
    return this.friends.listFriendRequests();
  }

  async acceptFriendRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.friends.acceptFriendRequest(requestId);
  }

  async rejectFriendRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.friends.rejectFriendRequest(requestId);
  }

  async deleteFriend(friendId: string): Promise<Record<string, unknown>> {
    return this.friends.deleteFriend(friendId);
  }

  // ─── Messaging ───

  async sendMessage(friendId: string, content: string): Promise<void> {
    return this.messaging.sendMessage(friendId, content);
  }

  async sendMediaMessage(
    friendId: string,
    msgType: string,
    mediaUrl?: string,
    fileInfo?: FileInfo,
    content?: string,
    mediaData?: string,
  ): Promise<void> {
    return this.messaging.sendMediaMessage(friendId, msgType, mediaUrl, fileInfo, content, mediaData);
  }

  async sendGroupMessage(groupId: string, content: string): Promise<void> {
    return this.messaging.sendGroupMessage(groupId, content);
  }

  async getGroupMessages(groupId: string, limit?: number, before?: string): Promise<Message[]> {
    return this.messaging.getGroupMessages(groupId, limit, before);
  }

  // ─── Streaming ───

  sendStreamChunk(friendId: string, chunkType: string, data: unknown): void {
    return this.messaging.sendStreamChunk(friendId, chunkType, data);
  }

  sendStreamEnd(friendId: string, messageId?: string): void {
    return this.messaging.sendStreamEnd(friendId, messageId);
  }

  sendStreamCancel(friendId: string): void {
    return this.messaging.sendStreamCancel(friendId);
  }

  isStreamCancelled(friendId: string): boolean {
    return this.messaging.isStreamCancelled(friendId);
  }

  clearStreamCancel(friendId: string): void {
    return this.messaging.clearStreamCancel(friendId);
  }

  // ─── File Transfer ───

  async uploadFile(filePath: string, filename?: string): Promise<string> {
    return this.messaging.uploadFile(filePath, filename);
  }

  sendFileChunk(friendId: string, sessionId: string, chunkIndex: number, chunkData: string): void {
    return this.messaging.sendFileChunk(friendId, sessionId, chunkIndex, chunkData);
  }

  // ─── Groups ───

  async listGroups(): Promise<Group[]> {
    return this.messaging.listGroups();
  }

  async createGroup(name: string, description?: string): Promise<Group> {
    return this.messaging.createGroup(name, description);
  }

  async inviteGroupMember(groupId: string, accountId: string): Promise<void> {
    return this.messaging.inviteGroupMember(groupId, accountId);
  }

  // ─── Ephemeral Rooms ───

  async joinEphemeralRoom(
    inviteCode: string,
    displayName: string,
    privateKey?: string,
  ): Promise<EphemeralJoinResponse> {
    const body: Record<string, unknown> = { inviteCode, displayName };
    if (privateKey) body.privateKey = privateKey;

    const res = await this.httpPost("/ephemeral/agent/join", JSON.stringify(body));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Join ephemeral room failed: ${errText}`,
        res.status,
        "/api/v1/ephemeral/agent/join",
      );
    }
    return res.json() as Promise<EphemeralJoinResponse>;
  }

  // ─── Temp Numbers ───

  /**
   * Resolve a temp number to account info.
   */
  async resolveTempNumber(number: string): Promise<TempNumberInfo> {
    const res = await this.httpGet(`/temp-number/${encodeURIComponent(number)}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Resolve temp number failed: ${errText}`,
        res.status,
        `/api/v1/temp-number/${number}`,
      );
    }
    return res.json() as Promise<TempNumberInfo>;
  }

  /**
   * Request a new temp number. (Server-assigned via platform broadcast or similar.)
   * Falls back to a placeholder if no dedicated endpoint exists.
   */
  async requestTempNumber(): Promise<string> {
    // No dedicated endpoint in SPEC — use broadcast or return empty
    throw new AICQError(
      "Temp number request not directly supported — use platform broadcast",
      undefined,
      "/api/v1/temp-number",
    );
  }

  // ─── Owner ───

  async setOwner(ownerId: string): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ ownerId });
    const res = await this.httpPost("/accounts/owner", body);
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Set owner failed: ${errText}`,
        res.status,
        "/api/v1/accounts/owner",
      );
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  async getOwner(): Promise<OwnerInfo> {
    const res = await this.httpGet("/accounts/owner");
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Get owner failed: ${errText}`,
        res.status,
        "/api/v1/accounts/owner",
      );
    }
    return res.json() as Promise<OwnerInfo>;
  }

  // ─── Account ───

  async getAccount(): Promise<AccountInfo> {
    const res = await this.httpGet("/accounts/me");
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Get account failed: ${errText}`,
        res.status,
        "/api/v1/accounts/me",
      );
    }
    return res.json() as Promise<AccountInfo>;
  }

  async lookupAccount(publicKey: string): Promise<AccountInfo> {
    const res = await this.httpGet(`/accounts/lookup?publicKey=${encodeURIComponent(publicKey)}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Account lookup failed: ${errText}`,
        res.status,
        "/api/v1/accounts/lookup",
      );
    }
    return res.json() as Promise<AccountInfo>;
  }

  // ─── Utility ───

  /**
   * Get current client status: auth state, WS connection, agent info.
   */
  getStatus(): Record<string, unknown> {
    const agent = this.auth.getCurrentAgent();
    return {
      serverUrl: this.serverUrl,
      connected: this.isConnected(),
      authenticated: !!this.auth.getAccessToken(),
      agentId: agent?.agentId ?? null,
      agentName: agent?.name ?? null,
    };
  }

  /**
   * Full cleanup: disconnect WS, clear tokens, reset state.
   */
  close(): void {
    this.ws.close();
    this.auth.clearTokens();
  }

  // ─── HTTP Layer (with auto 401 retry) ───

  /**
   * Build authorization headers from current tokens.
   */
  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.auth.getAccessToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Authenticated GET with auto-401 retry.
   */
  private async httpGet(endpoint: string): Promise<Response> {
    return this.httpRequest("GET", endpoint);
  }

  /**
   * Authenticated POST with auto-401 retry.
   */
  private async httpPost(endpoint: string, body?: string): Promise<Response> {
    return this.httpRequest("POST", endpoint, body);
  }

  /**
   * Authenticated DELETE with auto-401 retry.
   */
  private async httpDelete(endpoint: string): Promise<Response> {
    return this.httpRequest("DELETE", endpoint);
  }

  /**
   * Core HTTP request with automatic 401 retry:
   * 1. On 401, try refreshAuth()
   * 2. If refresh fails, try login()
   * 3. If login fails, raise AuthError
   * 4. After successful refresh/login, retry the request ONCE
   */
  private async httpRequest(
    method: string,
    endpoint: string,
    body?: string,
  ): Promise<Response> {
    const url = `${this.apiBase}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.buildAuthHeaders(),
    };

    const res = await fetch(url, { method, headers, body });

    // Auto 401 retry
    if (res.status === 401) {
      try {
        await this.auth.refreshAuth();
      } catch {
        // Refresh failed — try full login
        try {
          await this.auth.login();
        } catch (loginErr) {
          throw new AuthError(
            `Authentication failed after 401: ${(loginErr as Error).message}`,
            401,
            endpoint,
          );
        }
      }

      // Retry once with fresh token
      const retryHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.buildAuthHeaders(),
      };
      return fetch(url, { method, headers: retryHeaders, body });
    }

    return res;
  }
}
