"use strict";
/**
 * AICQ SDK — Ephemeral room client (HTTP-only, no WebSocket)
 * Implements AICQAgentClient from the spec.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AICQAgentClient = void 0;
const errors_1 = require("./errors");
const DEFAULT_SERVER = "https://aicq.me";
/**
 * AICQAgentClient — HTTP-only ephemeral room client.
 * No WebSocket, no persistent identity — just join and chat.
 */
class AICQAgentClient {
    constructor(serverUrl = DEFAULT_SERVER) {
        this.ephemeralId = null;
        this.roomId = null;
        this.token = null;
        this.serverUrl = serverUrl;
        this.apiBase = `${serverUrl}/api/v1`;
    }
    /**
     * Join an ephemeral room using an invite code.
     * @param inviteCode - Room invite code
     * @param displayName - Display name in the room
     * @param privateKey - Optional private key for authentication
     */
    async join(inviteCode, displayName, privateKey) {
        const body = { inviteCode, displayName };
        if (privateKey)
            body.privateKey = privateKey;
        const res = await fetch(`${this.apiBase}/ephemeral/agent/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Join ephemeral room failed: ${errText}`, res.status, "/api/v1/ephemeral/agent/join");
        }
        const data = (await res.json());
        this.ephemeralId = data.ephemeralId;
        this.roomId = data.roomId;
        this.token = data.token;
        return data;
    }
    /**
     * Chat in the ephemeral room.
     * @param speak - Whether to speak or just listen
     * @param content - Message content
     * @param waitSeconds - Seconds to wait for response
     * @param since - Timestamp to get messages since
     */
    async chat(speak, content, waitSeconds, since) {
        if (!this.ephemeralId || !this.token) {
            throw new errors_1.AICQError("Not joined — call join() first");
        }
        const body = {
            ephemeralId: this.ephemeralId,
            roomId: this.roomId,
            speak,
            content,
        };
        if (waitSeconds)
            body.waitSeconds = waitSeconds;
        if (since)
            body.since = since;
        const res = await fetch(`${this.apiBase}/ephemeral/agent/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Ephemeral chat failed: ${errText}`, res.status, "/api/v1/ephemeral/agent/chat");
        }
        return res.json();
    }
}
exports.AICQAgentClient = AICQAgentClient;
//# sourceMappingURL=ephemeral.js.map