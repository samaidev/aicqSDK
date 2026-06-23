/**
 * AICQ SDK — Messaging module
 * Handles private messages, group messages, media, streaming, and file transfer.
 * WS-first: private/group messages go via WebSocket first, REST fallback on WS failure.
 */
import type { Message, FileInfo, Group } from "./types";
/**
 * Provides messaging operations: private, group, media, streaming, file transfer.
 */
export declare class MessagingManager {
    private httpGet;
    private httpPost;
    private wsSend;
    private getCurrentAgentId;
    onAuthRefresh?: () => Promise<boolean>;
    private cancelledStreams;
    constructor(httpGet: (endpoint: string) => Promise<Response>, httpPost: (endpoint: string, body?: string) => Promise<Response>, wsSend: (msg: Record<string, unknown>) => boolean, getCurrentAgentId: () => string | null);
    /**
     * Send a private text message. WS-first with REST fallback.
     */
    sendMessage(friendId: string, content: string): Promise<void>;
    /**
     * Send a media message. WS-first with REST fallback.
     */
    sendMediaMessage(friendId: string, msgType: string, mediaUrl?: string, fileInfo?: FileInfo, content?: string, mediaData?: string): Promise<void>;
    /**
     * REST fallback for private messages.
     */
    private sendPrivateMessageREST;
    /**
     * Send a group message. WS-first with REST fallback.
     */
    sendGroupMessage(groupId: string, content: string): Promise<void>;
    /**
     * Get group messages (REST).
     */
    getGroupMessages(groupId: string, limit?: number, before?: string): Promise<Message[]>;
    /**
     * Send a stream chunk to a friend via WS.
     */
    sendStreamChunk(friendId: string, chunkType: string, data: unknown): void;
    /**
     * Signal the end of a stream via WS.
     */
    sendStreamEnd(friendId: string, messageId?: string): void;
    /**
     * Cancel a stream via WS.
     */
    sendStreamCancel(friendId: string): void;
    /**
     * Check if a stream has been cancelled by the recipient.
     */
    isStreamCancelled(friendId: string): boolean;
    /**
     * Clear the cancelled state for a stream.
     */
    clearStreamCancel(friendId: string): void;
    /**
     * Upload a file and return the URL.
     * @param filePath - Local path to the file
     * @param filename - Optional override for the filename
     * @returns URL of the uploaded file
     */
    uploadFile(filePath: string, filename?: string): Promise<string>;
    /**
     * Send a P2P file chunk via WS.
     */
    sendFileChunk(friendId: string, sessionId: string, chunkIndex: number, chunkData: string): void;
    /**
     * Get conversation history.
     */
    getConversation(conversationId: string): Promise<Message[]>;
    /**
     * Mark messages as read.
     */
    markRead(conversationId: string): Promise<void>;
    /**
     * List all groups.
     */
    listGroups(): Promise<Group[]>;
    /**
     * Create a new group.
     */
    createGroup(name: string, description?: string): Promise<Group>;
    /**
     * Invite a member to a group.
     */
    inviteGroupMember(groupId: string, accountId: string): Promise<void>;
    private apiBaseValue;
    private authHeadersFn;
    /** @internal */
    setApiBase(base: string): void;
    /** @internal */
    setAuthHeadersFn(fn: () => Record<string, string>): void;
    private getApiBase;
    private getAuthHeaders;
}
//# sourceMappingURL=messaging.d.ts.map