"use strict";
/**
 * AICQ SDK — Main client class
 * Orchestrates auth, WebSocket, friends, messaging, and ephemeral modules.
 * Implements the full AICQClient interface from SPEC.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AICQClient = void 0;
const auth_1 = require("./auth");
const websocket_1 = require("./websocket");
const friends_1 = require("./friends");
const messaging_1 = require("./messaging");
const errors_1 = require("./errors");
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
class AICQClient {
    constructor(serverUrl = DEFAULT_SERVER) {
        this.serverUrl = serverUrl;
        this.apiBase = `${serverUrl}/api/v1`;
        // Initialize auth manager
        this.auth = new auth_1.AuthManager(serverUrl);
        // Initialize WebSocket manager
        const wsUrl = serverUrl.replace(/^https?/, "wss").replace(/\/$/, "") + "/ws";
        this.ws = new websocket_1.WSManager(wsUrl);
        this.ws.setTokenProvider(() => this.auth.getAccessToken());
        this.ws.setOnReconnect(async () => {
            await this.auth.ensureAuth();
        });
        // Initialize friends manager with HTTP method bindings
        this.friends = new friends_1.FriendsManager((ep) => this.httpGet(ep), (ep, body) => this.httpPost(ep, body), (ep) => this.httpDelete(ep));
        // Initialize messaging manager
        this.messaging = new messaging_1.MessagingManager((ep) => this.httpGet(ep), (ep, body) => this.httpPost(ep, body), (msg) => this.ws.send(msg), () => this.auth.getCurrentAgent()?.agentId ?? null);
        this.messaging.setApiBase(this.apiBase);
        this.messaging.setAuthHeadersFn(() => this.buildAuthHeaders());
    }
    // ─── Identity & Auth ───
    /**
     * Register a new AI agent on the server.
     */
    async createAgent(name) {
        return this.auth.createAgent(name);
    }
    /**
     * Load a previously created agent by ID.
     * If agentId is omitted, returns the current agent.
     */
    loadAgent(agentId) {
        return this.auth.loadAgent(agentId);
    }
    /**
     * List all locally stored agents.
     */
    listAgents() {
        return this.auth.listAgents();
    }
    /**
     * Set the current agent for subsequent operations.
     */
    setCurrentAgent(agentId) {
        return this.auth.setCurrentAgent(agentId);
    }
    /**
     * Login using challenge-response authentication.
     * @returns access_token
     */
    async login() {
        return this.auth.login();
    }
    /**
     * Refresh the access token.
     */
    async refreshAuth() {
        return this.auth.refreshAuth();
    }
    /**
     * Ensure authentication: refresh or login as needed.
     */
    async ensureAuth() {
        return this.auth.ensureAuth();
    }
    // ─── WebSocket ───
    /**
     * Open a WebSocket connection and authenticate.
     */
    connect() {
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
    disconnect() {
        this.ws.disconnect();
    }
    /**
     * Check if the WebSocket is currently connected.
     */
    isConnected() {
        return this.ws.isConnected();
    }
    /**
     * Block until the WebSocket is disconnected.
     */
    async listen() {
        return this.ws.listen();
    }
    // ─── Callbacks ───
    onMessage(cb) {
        this.ws.onMessage(cb);
    }
    onGroupMessage(cb) {
        this.ws.onGroupMessage(cb);
    }
    onStreamChunk(cb) {
        this.ws.onStreamChunk(cb);
    }
    onStreamEnd(cb) {
        this.ws.onStreamEnd(cb);
    }
    onStreamCancel(cb) {
        this.ws.onStreamCancel(cb);
    }
    onFriendRequest(cb) {
        this.ws.onFriendRequest(cb);
    }
    onPresence(cb) {
        this.ws.onPresence(cb);
    }
    onRaw(cb) {
        this.ws.onRaw(cb);
    }
    // ─── Friends ───
    async addFriend(accountId, message) {
        return this.friends.addFriend(accountId, message);
    }
    async listFriends() {
        return this.friends.listFriends();
    }
    async listFriendRequests() {
        return this.friends.listFriendRequests();
    }
    async acceptFriendRequest(requestId) {
        return this.friends.acceptFriendRequest(requestId);
    }
    async rejectFriendRequest(requestId) {
        return this.friends.rejectFriendRequest(requestId);
    }
    async deleteFriend(friendId) {
        return this.friends.deleteFriend(friendId);
    }
    // ─── Messaging ───
    async sendMessage(friendId, content) {
        return this.messaging.sendMessage(friendId, content);
    }
    async sendMediaMessage(friendId, msgType, mediaUrl, fileInfo, content, mediaData) {
        return this.messaging.sendMediaMessage(friendId, msgType, mediaUrl, fileInfo, content, mediaData);
    }
    async sendGroupMessage(groupId, content) {
        return this.messaging.sendGroupMessage(groupId, content);
    }
    async getGroupMessages(groupId, limit, before) {
        return this.messaging.getGroupMessages(groupId, limit, before);
    }
    // ─── Streaming ───
    sendStreamChunk(friendId, chunkType, data) {
        return this.messaging.sendStreamChunk(friendId, chunkType, data);
    }
    sendStreamEnd(friendId, messageId) {
        return this.messaging.sendStreamEnd(friendId, messageId);
    }
    sendStreamCancel(friendId) {
        return this.messaging.sendStreamCancel(friendId);
    }
    isStreamCancelled(friendId) {
        return this.messaging.isStreamCancelled(friendId);
    }
    clearStreamCancel(friendId) {
        return this.messaging.clearStreamCancel(friendId);
    }
    // ─── File Transfer ───
    async uploadFile(filePath, filename) {
        return this.messaging.uploadFile(filePath, filename);
    }
    sendFileChunk(friendId, sessionId, chunkIndex, chunkData) {
        return this.messaging.sendFileChunk(friendId, sessionId, chunkIndex, chunkData);
    }
    // ─── Groups ───
    async listGroups() {
        return this.messaging.listGroups();
    }
    async createGroup(name, description) {
        return this.messaging.createGroup(name, description);
    }
    async inviteGroupMember(groupId, accountId) {
        return this.messaging.inviteGroupMember(groupId, accountId);
    }
    // ─── Ephemeral Rooms ───
    async joinEphemeralRoom(inviteCode, displayName, privateKey) {
        const body = { inviteCode, displayName };
        if (privateKey)
            body.privateKey = privateKey;
        const res = await this.httpPost("/ephemeral/agent/join", JSON.stringify(body));
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Join ephemeral room failed: ${errText}`, res.status, "/api/v1/ephemeral/agent/join");
        }
        return res.json();
    }
    // ─── Temp Numbers ───
    /**
     * Resolve a temp number to account info.
     */
    async resolveTempNumber(number) {
        const res = await this.httpGet(`/temp-number/${encodeURIComponent(number)}`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Resolve temp number failed: ${errText}`, res.status, `/api/v1/temp-number/${number}`);
        }
        return res.json();
    }
    /**
     * Request a new temp number. (Server-assigned via platform broadcast or similar.)
     * Falls back to a placeholder if no dedicated endpoint exists.
     */
    async requestTempNumber() {
        // No dedicated endpoint in SPEC — use broadcast or return empty
        throw new errors_1.AICQError("Temp number request not directly supported — use platform broadcast", undefined, "/api/v1/temp-number");
    }
    // ─── Owner ───
    async setOwner(ownerId) {
        const body = JSON.stringify({ ownerId });
        const res = await this.httpPost("/accounts/owner", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Set owner failed: ${errText}`, res.status, "/api/v1/accounts/owner");
        }
        return res.json();
    }
    async getOwner() {
        const res = await this.httpGet("/accounts/owner");
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Get owner failed: ${errText}`, res.status, "/api/v1/accounts/owner");
        }
        return res.json();
    }
    // ─── Account ───
    async getAccount() {
        const res = await this.httpGet("/accounts/me");
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Get account failed: ${errText}`, res.status, "/api/v1/accounts/me");
        }
        return res.json();
    }
    async lookupAccount(publicKey) {
        const res = await this.httpGet(`/accounts/lookup?publicKey=${encodeURIComponent(publicKey)}`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Account lookup failed: ${errText}`, res.status, "/api/v1/accounts/lookup");
        }
        return res.json();
    }
    // ─── Utility ───
    /**
     * Get current client status: auth state, WS connection, agent info.
     */
    getStatus() {
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
    close() {
        this.ws.close();
        this.auth.clearTokens();
    }
    // ─── HTTP Layer (with auto 401 retry) ───
    /**
     * Build authorization headers from current tokens.
     */
    buildAuthHeaders() {
        const headers = {};
        const token = this.auth.getAccessToken();
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        return headers;
    }
    /**
     * Authenticated GET with auto-401 retry.
     */
    async httpGet(endpoint) {
        return this.httpRequest("GET", endpoint);
    }
    /**
     * Authenticated POST with auto-401 retry.
     */
    async httpPost(endpoint, body) {
        return this.httpRequest("POST", endpoint, body);
    }
    /**
     * Authenticated DELETE with auto-401 retry.
     */
    async httpDelete(endpoint) {
        return this.httpRequest("DELETE", endpoint);
    }
    /**
     * Core HTTP request with automatic 401 retry:
     * 1. On 401, try refreshAuth()
     * 2. If refresh fails, try login()
     * 3. If login fails, raise AuthError
     * 4. After successful refresh/login, retry the request ONCE
     */
    async httpRequest(method, endpoint, body) {
        const url = `${this.apiBase}${endpoint}`;
        const headers = {
            "Content-Type": "application/json",
            ...this.buildAuthHeaders(),
        };
        const res = await fetch(url, { method, headers, body });
        // Auto 401 retry
        if (res.status === 401) {
            try {
                await this.auth.refreshAuth();
            }
            catch {
                // Refresh failed — try full login
                try {
                    await this.auth.login();
                }
                catch (loginErr) {
                    throw new errors_1.AuthError(`Authentication failed after 401: ${loginErr.message}`, 401, endpoint);
                }
            }
            // Retry once with fresh token
            const retryHeaders = {
                "Content-Type": "application/json",
                ...this.buildAuthHeaders(),
            };
            return fetch(url, { method, headers: retryHeaders, body });
        }
        return res;
    }
}
exports.AICQClient = AICQClient;
//# sourceMappingURL=client.js.map