"use strict";
/**
 * AICQ SDK — Friends management module
 * Handles friend listing, requests, accept/reject, and removal.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FriendsManager = void 0;
const errors_1 = require("./errors");
/**
 * Provides friend management operations against the AICQ REST API.
 */
class FriendsManager {
    constructor(httpGet, httpPost, httpDelete) {
        this.httpGet = httpGet;
        this.httpPost = httpPost;
        this.httpDelete = httpDelete;
    }
    /**
     * Send a friend request to an account.
     */
    async addFriend(accountId, message) {
        const body = JSON.stringify({ accountId, message });
        const res = await this.httpPost("/friends/request", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Add friend failed: ${errText}`, res.status, "/api/v1/friends/request");
        }
        return res.json();
    }
    /**
     * List all friends.
     */
    async listFriends() {
        const res = await this.httpGet("/friends");
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`List friends failed: ${errText}`, res.status, "/api/v1/friends");
        }
        const data = (await res.json());
        return Array.isArray(data) ? data : data.friends ?? [];
    }
    /**
     * List friend requests (both sent and received).
     */
    async listFriendRequests() {
        const res = await this.httpGet("/friends/requests");
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`List friend requests failed: ${errText}`, res.status, "/api/v1/friends/requests");
        }
        const data = (await res.json());
        return {
            sent: data.sent ?? [],
            received: data.received ?? [],
        };
    }
    /**
     * Accept a friend request.
     */
    async acceptFriendRequest(requestId) {
        const res = await this.httpPost(`/friends/requests/${requestId}/accept`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Accept friend request failed: ${errText}`, res.status, `/api/v1/friends/requests/${requestId}/accept`);
        }
        return res.json();
    }
    /**
     * Reject a friend request.
     */
    async rejectFriendRequest(requestId) {
        const res = await this.httpPost(`/friends/requests/${requestId}/reject`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Reject friend request failed: ${errText}`, res.status, `/api/v1/friends/requests/${requestId}/reject`);
        }
        return res.json();
    }
    /**
     * Remove a friend.
     */
    async deleteFriend(friendId) {
        const res = await this.httpDelete(`/friends/${friendId}`);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AICQError(`Delete friend failed: ${errText}`, res.status, `/api/v1/friends/${friendId}`);
        }
        return res.json();
    }
}
exports.FriendsManager = FriendsManager;
//# sourceMappingURL=friends.js.map