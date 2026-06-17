/**
 * AICQ SDK — Ephemeral room client (HTTP-only, no WebSocket)
 * Implements AICQAgentClient from the spec.
 */
import type { EphemeralJoinResponse, EphemeralChatResponse } from "./types";
/**
 * AICQAgentClient — HTTP-only ephemeral room client.
 * No WebSocket, no persistent identity — just join and chat.
 */
export declare class AICQAgentClient {
    private serverUrl;
    private apiBase;
    private ephemeralId;
    private roomId;
    private token;
    constructor(serverUrl?: string);
    /**
     * Join an ephemeral room using an invite code.
     * @param inviteCode - Room invite code
     * @param displayName - Display name in the room
     * @param privateKey - Optional private key for authentication
     */
    join(inviteCode: string, displayName: string, privateKey?: string): Promise<EphemeralJoinResponse>;
    /**
     * Chat in the ephemeral room.
     * @param speak - Whether to speak or just listen
     * @param content - Message content
     * @param waitSeconds - Seconds to wait for response
     * @param since - Timestamp to get messages since
     */
    chat(speak: boolean, content: string, waitSeconds?: number, since?: string): Promise<EphemeralChatResponse>;
}
//# sourceMappingURL=ephemeral.d.ts.map