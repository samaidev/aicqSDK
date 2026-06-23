/**
 * AICQ SDK — Public API surface
 * Re-exports all modules for consumer access.
 */
export { AICQClient } from "./client";
export { AICQAgentClient } from "./ephemeral";
export { invokeAgentStream, type AgentMessageContent, type StreamEvent, type InvokeAgentStreamOptions, } from "./invoke";
export { generateSigningKeypair, generateExchangeKeypair, sign, verify, encrypt, decrypt, boxEncrypt, boxDecrypt, generateNonce, computeFingerprint, derivePublicKeyFromSecret, } from "./crypto";
export { AICQError, AuthError, ConnectionError } from "./errors";
export type { Agent, AuthTokens, RegisterAIResponse, ChallengeResponse, LoginAgentResponse, RefreshResponse, Friend, FriendRequest, FriendRequestsResponse, Group, GroupMember, Message, FileInfo, SendMessagePayload, SendGroupMessagePayload, StreamChunkPayload, StreamEndPayload, StreamCancelPayload, StreamChunkMessage, StreamEndMessage, StreamCancelMessage, FileChunkPayload, WSOnlineMessage, WSOfflineMessage, WSMessageMessage, WSGroupMessage, WSEphemeralOnlineMessage, WSOutboundMessage, InboundMessage, PrivateMessageInbound, GroupMessageInbound, PresenceMessage, FriendRequestInbound, ErrorMessage, OnlineAckMessage, EphemeralJoinResponse, EphemeralChatResponse, EphemeralChatMessage, AccountInfo, OwnerInfo, TempNumberInfo, MessageCallback, GroupMessageCallback, StreamChunkCallback, StreamEndCallback, StreamCancelCallback, FriendRequestCallback, PresenceCallback, RawCallback, AICQClientConfig, UploadResponse, } from "./types";
//# sourceMappingURL=index.d.ts.map