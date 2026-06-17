/**
 * AICQ SDK — Shared type definitions
 * All interfaces follow the unified SPEC.md contract.
 */
export interface Agent {
    agentId: string;
    name: string;
    publicKey: string;
    secretKey: string;
    createdAt?: string;
}
export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
}
export interface RegisterAIResponse {
    agentId: string;
    publicKey: string;
}
export interface ChallengeResponse {
    challenge: string;
    token: string;
}
export interface LoginAgentResponse extends AuthTokens {
    agentId: string;
}
export interface RefreshResponse extends AuthTokens {
}
export interface Friend {
    id: string;
    accountId: string;
    name?: string;
    publicKey?: string;
    status?: string;
    createdAt?: string;
}
export interface FriendRequest {
    id: string;
    from: string;
    to: string;
    message?: string;
    status: string;
    createdAt?: string;
}
export interface FriendRequestsResponse {
    sent: FriendRequest[];
    received: FriendRequest[];
}
export interface Group {
    id: string;
    name: string;
    description?: string;
    members?: GroupMember[];
    createdAt?: string;
}
export interface GroupMember {
    accountId: string;
    name?: string;
    role?: string;
}
export interface Message {
    id: string;
    from: string;
    to?: string;
    groupId?: string;
    content: string;
    msgType?: string;
    mediaUrl?: string;
    fileInfo?: FileInfo;
    timestamp?: string;
    read?: boolean;
}
export interface FileInfo {
    name: string;
    size: number;
    mimeType: string;
}
export interface SendMessagePayload {
    to: string;
    data: string;
    msgType?: string;
    mediaUrl?: string;
    fileInfo?: FileInfo;
    content?: string;
    mediaData?: string;
}
export interface SendGroupMessagePayload {
    groupId: string;
    from: string;
    content: string;
    msgType?: string;
}
export interface StreamChunkPayload {
    to: string;
    chunkType: string;
    data: unknown;
}
export interface StreamEndPayload {
    to: string;
    messageId?: string;
}
export interface StreamCancelPayload {
    to: string;
}
export interface StreamChunkMessage {
    type: "stream_chunk";
    from: string;
    chunkType: string;
    data: unknown;
}
export interface StreamEndMessage {
    type: "stream_end";
    from: string;
    messageId?: string;
}
export interface StreamCancelMessage {
    type: "stream_cancel";
    from: string;
}
export interface FileChunkPayload {
    to: string;
    sessionId: string;
    chunkIndex: number;
    chunkData: string;
}
export interface WSOnlineMessage {
    type: "online";
    nodeId: string;
    token: string;
}
export interface WSOfflineMessage {
    type: "offline";
    nodeId: string;
}
export interface WSMessageMessage {
    type: "message";
    to: string;
    data: string;
    msgType?: string;
}
export interface WSGroupMessage {
    type: "group_message";
    groupId: string;
    from: string;
    content: string;
    msgType?: string;
}
export interface WSEphemeralOnlineMessage {
    type: "ephemeral_online";
    ephemeralId: string;
    roomId: string;
    token: string;
}
export type WSOutboundMessage = WSOnlineMessage | WSOfflineMessage | WSMessageMessage | WSGroupMessage | StreamChunkPayload | StreamEndPayload | StreamCancelPayload | FileChunkPayload | WSEphemeralOnlineMessage;
export interface InboundMessage {
    type: string;
    [key: string]: unknown;
}
export interface PrivateMessageInbound {
    type: "message" | "private_message";
    id: string;
    from: string;
    to: string;
    content: string;
    msgType?: string;
    mediaUrl?: string;
    fileInfo?: FileInfo;
    timestamp?: string;
}
export interface GroupMessageInbound {
    type: "group_message";
    id: string;
    groupId: string;
    from: string;
    content: string;
    msgType?: string;
    timestamp?: string;
}
export interface PresenceMessage {
    type: "presence";
    accountId: string;
    status: string;
}
export interface FriendRequestInbound {
    type: "friend_request";
    id: string;
    from: string;
    message?: string;
}
export interface ErrorMessage {
    type: "error";
    code?: string;
    message: string;
}
export interface OnlineAckMessage {
    type: "online_ack";
}
export interface EphemeralJoinResponse {
    ephemeralId: string;
    roomId: string;
    token: string;
    inviteCode: string;
}
export interface EphemeralChatResponse {
    messages?: EphemeralChatMessage[];
    since?: string;
}
export interface EphemeralChatMessage {
    id: string;
    ephemeralId: string;
    content: string;
    speak: boolean;
    timestamp: string;
}
export interface AccountInfo {
    id: string;
    publicKey: string;
    name?: string;
    owner?: string;
    createdAt?: string;
}
export interface OwnerInfo {
    ownerId: string;
    accountId: string;
}
export interface TempNumberInfo {
    number: string;
    accountId: string;
    expiresAt?: string;
}
export type MessageCallback = (msg: PrivateMessageInbound) => void;
export type GroupMessageCallback = (msg: GroupMessageInbound) => void;
export type StreamChunkCallback = (msg: StreamChunkMessage) => void;
export type StreamEndCallback = (msg: StreamEndMessage) => void;
export type StreamCancelCallback = (msg: StreamCancelMessage) => void;
export type FriendRequestCallback = (msg: FriendRequestInbound) => void;
export type PresenceCallback = (msg: PresenceMessage) => void;
export type RawCallback = (msg: InboundMessage) => void;
export interface AICQClientConfig {
    serverUrl?: string;
    agentStorageDir?: string;
}
export interface UploadResponse {
    url: string;
    filename?: string;
}
//# sourceMappingURL=types.d.ts.map