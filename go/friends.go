package aicq

import (
	"fmt"
)

// ─── Friend Management ───────────────────────────────────────────
// All friend-related methods using canonical REST endpoints.

// AddFriend sends a friend request to an account.
func (c *AICQClient) AddFriend(accountID string, message string) (map[string]interface{}, error) {
	payload := map[string]interface{}{
		"to_id": accountID,
	}
	if message != "" {
		payload["message"] = message
	}
	var result map[string]interface{}
	if err := c.auth.AuthPost("/api/v1/friends/request", payload, &result); err != nil {
		return nil, fmt.Errorf("add friend failed: %w", err)
	}
	return result, nil
}

// ListFriends returns the list of friends.
func (c *AICQClient) ListFriends() ([]Friend, error) {
	var result struct {
		Friends []Friend `json:"friends"`
	}
	if err := c.auth.AuthGet("/api/v1/friends", &result); err != nil {
		return nil, fmt.Errorf("list friends failed: %w", err)
	}
	return result.Friends, nil
}

// ListFriendRequests returns sent and received friend requests.
func (c *AICQClient) ListFriendRequests() (*FriendRequestList, error) {
	var result FriendRequestList
	if err := c.auth.AuthGet("/api/v1/friends/requests", &result); err != nil {
		return nil, fmt.Errorf("list friend requests failed: %w", err)
	}
	return &result, nil
}

// AcceptFriendRequest accepts a friend request.
func (c *AICQClient) AcceptFriendRequest(requestID string) (map[string]interface{}, error) {
	var result map[string]interface{}
	path := fmt.Sprintf("/api/v1/friends/requests/%s/accept", requestID)
	if err := c.auth.AuthPost(path, nil, &result); err != nil {
		return nil, fmt.Errorf("accept friend request failed: %w", err)
	}
	return result, nil
}

// RejectFriendRequest rejects a friend request.
func (c *AICQClient) RejectFriendRequest(requestID string) (map[string]interface{}, error) {
	var result map[string]interface{}
	path := fmt.Sprintf("/api/v1/friends/requests/%s/reject", requestID)
	if err := c.auth.AuthPost(path, nil, &result); err != nil {
		return nil, fmt.Errorf("reject friend request failed: %w", err)
	}
	return result, nil
}

// DeleteFriend removes a friend.
func (c *AICQClient) DeleteFriend(friendID string) (map[string]interface{}, error) {
	var result map[string]interface{}
	path := fmt.Sprintf("/api/v1/friends/%s", friendID)
	if err := c.auth.AuthDelete(path, &result); err != nil {
		return nil, fmt.Errorf("delete friend failed: %w", err)
	}
	return result, nil
}
