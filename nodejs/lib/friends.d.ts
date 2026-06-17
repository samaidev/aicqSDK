/**
 * AICQ SDK — Friends management module
 * Handles friend listing, requests, accept/reject, and removal.
 */
import type { Friend, FriendRequestsResponse } from "./types";
/**
 * Provides friend management operations against the AICQ REST API.
 */
export declare class FriendsManager {
    private httpGet;
    private httpPost;
    private httpDelete;
    constructor(httpGet: (endpoint: string) => Promise<Response>, httpPost: (endpoint: string, body?: string) => Promise<Response>, httpDelete: (endpoint: string) => Promise<Response>);
    /**
     * Send a friend request to an account.
     */
    addFriend(accountId: string, message?: string): Promise<Record<string, unknown>>;
    /**
     * List all friends.
     */
    listFriends(): Promise<Friend[]>;
    /**
     * List friend requests (both sent and received).
     */
    listFriendRequests(): Promise<FriendRequestsResponse>;
    /**
     * Accept a friend request.
     */
    acceptFriendRequest(requestId: string): Promise<Record<string, unknown>>;
    /**
     * Reject a friend request.
     */
    rejectFriendRequest(requestId: string): Promise<Record<string, unknown>>;
    /**
     * Remove a friend.
     */
    deleteFriend(friendId: string): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=friends.d.ts.map