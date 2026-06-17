"use strict";
/**
 * AICQ SDK — Messaging module
 * Handles private messages, group messages, media, streaming, and file transfer.
 * WS-first: private/group messages go via WebSocket first, REST fallback on WS failure.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingManager = void 0;
const errors_1 = require("./errors");
/**
 * Provides messaging operations: private, group, media, streaming, file transfer.
 */
class MessagingManager {
    constructor(httpGet, httpPost, wsSend, getCurrentAgentId) {
        // Track stream cancellations per friend
        this.cancelledStreams = new Set();
        // ─── Helpers (injected from client) ───
        this.apiBaseValue = "";
        this.authHeadersFn = () => ({});
        this.httpGet = httpGet;
        this.httpPost = httpPost;
        this.wsSend = wsSend;
        this.getCurrentAgentId = getCurrentAgentId;
    }
    // ─── Private Messages ───
    /**
     * Send a private text message. WS-first with REST fallback.
     */
    async sendMessage(friendId, content) {
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
    async sendMediaMessage(friendId, msgType, mediaUrl, fileInfo, content, mediaData) {
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
                throw new errors_1.AICQError(`Send media message failed: ${errText}`, res.status, "/api/v1/chat/messages");
            }
        }
    }
    /**
     * REST fallback for private messages.
     */
    async sendPrivateMessageREST(friendId, content) {
        const body = JSON.stringify({ to: friendId, data: content });
        const res = await this.httpPost("/chat/messages", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Send message (REST) failed: ${errText}`, res.status, "/api/v1/chat/messages");
        }
    }
    // ─── Group Messages ───
    /**
     * Send a group message. WS-first with REST fallback.
     */
    async sendGroupMessage(groupId, content) {
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
                throw new errors_1.AICQError(`Send group message failed: ${errText}`, res.status, `/api/v1/groups/${groupId}/messages`);
            }
        }
    }
    /**
     * Get group messages (REST).
     */
    async getGroupMessages(groupId, limit, before) {
        let endpoint = `/groups/${groupId}/messages`;
        const params = [];
        if (limit)
            params.push(`limit=${limit}`);
        if (before)
            params.push(`before=${encodeURIComponent(before)}`);
        if (params.length > 0)
            endpoint += `?${params.join("&")}`;
        const res = await this.httpGet(endpoint);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Get group messages failed: ${errText}`, res.status, `/api/v1/groups/${groupId}/messages`);
        }
        const data = (await res.json());
        return Array.isArray(data) ? data : data.messages ?? [];
    }
    // ─── Streaming ───
    /**
     * Send a stream chunk to a friend via WS.
     */
    sendStreamChunk(friendId, chunkType, data) {
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
    sendStreamEnd(friendId, messageId) {
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
    sendStreamCancel(friendId) {
        this.wsSend({
            type: "stream_cancel",
            to: friendId,
        });
        this.cancelledStreams.add(friendId);
    }
    /**
     * Check if a stream has been cancelled by the recipient.
     */
    isStreamCancelled(friendId) {
        return this.cancelledStreams.has(friendId);
    }
    /**
     * Clear the cancelled state for a stream.
     */
    clearStreamCancel(friendId) {
        this.cancelledStreams.delete(friendId);
    }
    // ─── File Transfer ───
    /**
     * Upload a file and return the URL.
     * @param filePath - Local path to the file
     * @param filename - Optional override for the filename
     * @returns URL of the uploaded file
     */
    async uploadFile(filePath, filename) {
        const fs = await Promise.resolve().then(() => __importStar(require("fs")));
        const path = await Promise.resolve().then(() => __importStar(require("path")));
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
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`File upload failed: ${errText}`, res.status, "/api/v1/chat/upload");
        }
        const data = (await res.json());
        return data.url;
    }
    /**
     * Send a P2P file chunk via WS.
     */
    sendFileChunk(friendId, sessionId, chunkIndex, chunkData) {
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
    async getConversation(conversationId) {
        const res = await this.httpGet(`/chat/conversation/${conversationId}`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Get conversation failed: ${errText}`, res.status, `/api/v1/chat/conversation/${conversationId}`);
        }
        const data = (await res.json());
        return Array.isArray(data) ? data : data.messages ?? [];
    }
    /**
     * Mark messages as read.
     */
    async markRead(conversationId) {
        const body = JSON.stringify({ conversationId });
        const res = await this.httpPost("/chat/mark-read", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Mark read failed: ${errText}`, res.status, "/api/v1/chat/mark-read");
        }
    }
    // ─── Groups ───
    /**
     * List all groups.
     */
    async listGroups() {
        const res = await this.httpGet("/groups");
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`List groups failed: ${errText}`, res.status, "/api/v1/groups");
        }
        const data = (await res.json());
        return Array.isArray(data) ? data : data.groups ?? [];
    }
    /**
     * Create a new group.
     */
    async createGroup(name, description) {
        const body = JSON.stringify({ name, description });
        const res = await this.httpPost("/groups", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Create group failed: ${errText}`, res.status, "/api/v1/groups");
        }
        return res.json();
    }
    /**
     * Invite a member to a group.
     */
    async inviteGroupMember(groupId, accountId) {
        const body = JSON.stringify({ accountId });
        const res = await this.httpPost(`/groups/${groupId}/members`, body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Invite group member failed: ${errText}`, res.status, `/api/v1/groups/${groupId}/members`);
        }
    }
    /** @internal */
    setApiBase(base) {
        this.apiBaseValue = base;
    }
    /** @internal */
    setAuthHeadersFn(fn) {
        this.authHeadersFn = fn;
    }
    getApiBase() {
        return this.apiBaseValue;
    }
    getAuthHeaders() {
        return this.authHeadersFn();
    }
}
exports.MessagingManager = MessagingManager;
//# sourceMappingURL=messaging.js.map