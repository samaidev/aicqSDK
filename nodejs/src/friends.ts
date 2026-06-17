/**
 * AICQ SDK — Friends management module
 * Handles friend listing, requests, accept/reject, and removal.
 */

import type {
  Friend,
  FriendRequestsResponse,
  FriendRequest,
} from "./types";
import { AICQError } from "./errors";

/**
 * Provides friend management operations against the AICQ REST API.
 */
export class FriendsManager {
  private httpGet: (endpoint: string) => Promise<Response>;
  private httpPost: (endpoint: string, body?: string) => Promise<Response>;
  private httpDelete: (endpoint: string) => Promise<Response>;

  constructor(
    httpGet: (endpoint: string) => Promise<Response>,
    httpPost: (endpoint: string, body?: string) => Promise<Response>,
    httpDelete: (endpoint: string) => Promise<Response>,
  ) {
    this.httpGet = httpGet;
    this.httpPost = httpPost;
    this.httpDelete = httpDelete;
  }

  /**
   * Send a friend request to an account.
   */
  async addFriend(accountId: string, message?: string): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ accountId, message });
    const res = await this.httpPost("/friends/request", body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Add friend failed: ${errText}`,
        res.status,
        "/api/v1/friends/request",
      );
    }

    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * List all friends.
   */
  async listFriends(): Promise<Friend[]> {
    const res = await this.httpGet("/friends");

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `List friends failed: ${errText}`,
        res.status,
        "/api/v1/friends",
      );
    }

    const data = (await res.json()) as Record<string, unknown> | Friend[];
    return Array.isArray(data) ? data : ((data as Record<string, unknown>).friends as Friend[]) ?? [];
  }

  /**
   * List friend requests (both sent and received).
   */
  async listFriendRequests(): Promise<FriendRequestsResponse> {
    const res = await this.httpGet("/friends/requests");

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `List friend requests failed: ${errText}`,
        res.status,
        "/api/v1/friends/requests",
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      sent: (data.sent as FriendRequest[]) ?? [],
      received: (data.received as FriendRequest[]) ?? [],
    };
  }

  /**
   * Accept a friend request.
   */
  async acceptFriendRequest(requestId: string): Promise<Record<string, unknown>> {
    const res = await this.httpPost(`/friends/requests/${requestId}/accept`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Accept friend request failed: ${errText}`,
        res.status,
        `/api/v1/friends/requests/${requestId}/accept`,
      );
    }

    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Reject a friend request.
   */
  async rejectFriendRequest(requestId: string): Promise<Record<string, unknown>> {
    const res = await this.httpPost(`/friends/requests/${requestId}/reject`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Reject friend request failed: ${errText}`,
        res.status,
        `/api/v1/friends/requests/${requestId}/reject`,
      );
    }

    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Remove a friend.
   */
  async deleteFriend(friendId: string): Promise<Record<string, unknown>> {
    const res = await this.httpDelete(`/friends/${friendId}`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AICQError(
        `Delete friend failed: ${errText}`,
        res.status,
        `/api/v1/friends/${friendId}`,
      );
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
