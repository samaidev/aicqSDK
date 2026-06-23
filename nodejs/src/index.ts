/**
 * AICQ SDK — Public API surface
 * Re-exports all modules for consumer access.
 */

// Main client class
export { AICQClient } from "./client";

// Ephemeral (HTTP-only) client
export { AICQAgentClient } from "./ephemeral";

// One-shot invocation helper (high-level convenience)
export {
  invokeAgentStream,
  type AgentMessageContent,
  type StreamEvent,
  type InvokeAgentStreamOptions,
} from "./invoke";

// Crypto module (all functions)
export {
  generateSigningKeypair,
  generateExchangeKeypair,
  sign,
  verify,
  encrypt,
  decrypt,
  boxEncrypt,
  boxDecrypt,
  generateNonce,
  computeFingerprint,
  derivePublicKeyFromSecret,
} from "./crypto";

// Error classes
export { AICQError, AuthError, ConnectionError } from "./errors";

// All shared types
export type {
  Agent,
  AuthTokens,
  RegisterAIResponse,
  ChallengeResponse,
  LoginAgentResponse,
  RefreshResponse,
  Friend,
  FriendRequest,
  FriendRequestsResponse,
  Group,
  GroupMember,
  Message,
  FileInfo,
  SendMessagePayload,
  SendGroupMessagePayload,
  StreamChunkPayload,
  StreamEndPayload,
  StreamCancelPayload,
  StreamChunkMessage,
  StreamEndMessage,
  StreamCancelMessage,
  FileChunkPayload,
  WSOnlineMessage,
  WSOfflineMessage,
  WSMessageMessage,
  WSGroupMessage,
  WSEphemeralOnlineMessage,
  WSOutboundMessage,
  InboundMessage,
  PrivateMessageInbound,
  GroupMessageInbound,
  PresenceMessage,
  FriendRequestInbound,
  ErrorMessage,
  OnlineAckMessage,
  EphemeralJoinResponse,
  EphemeralChatResponse,
  EphemeralChatMessage,
  AccountInfo,
  OwnerInfo,
  TempNumberInfo,
  MessageCallback,
  GroupMessageCallback,
  StreamChunkCallback,
  StreamEndCallback,
  StreamCancelCallback,
  FriendRequestCallback,
  PresenceCallback,
  RawCallback,
  AICQClientConfig,
  UploadResponse,
} from "./types";
