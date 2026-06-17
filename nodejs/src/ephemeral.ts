/**
 * AICQ SDK — Ephemeral room client (HTTP-only, no WebSocket)
 * Implements AICQAgentClient from the spec.
 */

import type { EphemeralJoinResponse, EphemeralChatResponse } from "./types";
import { AICQError } from "./errors";

const DEFAULT_SERVER = "https://aicq.me";

/**
 * AICQAgentClient — HTTP-only ephemeral room client.
 * No WebSocket, no persistent identity — just join and chat.
 */
export class AICQAgentClient {
  private serverUrl: string;
  private apiBase: string;
  private ephemeralId: string | null = null;
  private roomId: string | null = null;
  private token: string | null = null;

  constructor(serverUrl: string = DEFAULT_SERVER) {
    this.serverUrl = serverUrl;
    this.apiBase = `${serverUrl}/api/v1`;
  }

  /**
   * Join an ephemeral room using an invite code.
   * @param inviteCode - Room invite code
   * @param displayName - Display name in the room
   * @param privateKey - Optional private key for authentication
   */
  async join(
    inviteCode: string,
    displayName: string,
    privateKey?: string,
  ): Promise<EphemeralJoinResponse> {
    const body: Record<string, unknown> = { inviteCode, displayName };
    if (privateKey) body.privateKey = privateKey;

    const res = await fetch(`${this.apiBase}/ephemeral/agent/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Join ephemeral room failed: ${errText}`,
        res.status,
        "/api/v1/ephemeral/agent/join",
      );
    }

    const data = (await res.json()) as EphemeralJoinResponse;
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
  async chat(
    speak: boolean,
    content: string,
    waitSeconds?: number,
    since?: string,
  ): Promise<EphemeralChatResponse> {
    if (!this.ephemeralId || !this.token) {
      throw new AICQError("Not joined — call join() first");
    }

    const body: Record<string, unknown> = {
      ephemeralId: this.ephemeralId,
      roomId: this.roomId,
      speak,
      content,
    };
    if (waitSeconds) body.waitSeconds = waitSeconds;
    if (since) body.since = since;

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
      throw new AICQError(
        `Ephemeral chat failed: ${errText}`,
        res.status,
        "/api/v1/ephemeral/agent/chat",
      );
    }

    return res.json() as Promise<EphemeralChatResponse>;
  }
}
