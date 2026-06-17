package aicq

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// ─── Messaging ───────────────────────────────────────────────────
// WS-first messaging: private/group messages via WS, REST fallback on WS failure.
// Includes: sendMessage, sendMediaMessage, sendGroupMessage, stream methods,
// uploadFile, sendFileChunk, markRead.

// SendMessage sends a private text message to a friend.
// WS-first: tries WS first, falls back to REST on failure.
func (c *AICQClient) SendMessage(friendID string, content string) error {
	// Try WS first
	if c.ws.IsConnected() {
		msgData := map[string]interface{}{
			"type":    "text",
			"content": content,
		}
		if err := c.ws.SendMessage(friendID, msgData); err != nil {
			log.Printf("[Messaging] WS send failed, falling back to REST: %v", err)
		} else {
			return nil
		}
	}

	// REST fallback
	payload := map[string]interface{}{
		"to_id":   friendID,
		"content": content,
		"msg_type": "text",
	}
	var result interface{}
	return c.auth.AuthPost("/api/v1/chat/messages", payload, &result)
}

// SendMediaMessage sends a message with media attachment to a friend.
// msgType can be "text", "image", "file", etc.
func (c *AICQClient) SendMediaMessage(friendID string, msgType string, mediaURL string, fileInfo map[string]interface{}, content string, mediaData string) error {
	// Try WS first
	if c.ws.IsConnected() {
		msgData := map[string]interface{}{
			"type":      msgType,
			"content":   content,
			"media_url": mediaURL,
			"file_info": fileInfo,
		}
		if mediaData != "" {
			msgData["media_data"] = mediaData
		}
		if err := c.ws.SendMessage(friendID, msgData); err != nil {
			log.Printf("[Messaging] WS send media failed, falling back to REST: %v", err)
		} else {
			return nil
		}
	}

	// REST fallback
	payload := map[string]interface{}{
		"to_id":     friendID,
		"content":   content,
		"msg_type":  msgType,
		"media_url": mediaURL,
	}
	if fileInfo != nil {
		payload["file_info"] = fileInfo
	}
	if mediaData != "" {
		payload["media_data"] = mediaData
	}
	var result interface{}
	return c.auth.AuthPost("/api/v1/chat/messages", payload, &result)
}

// SendGroupMessage sends a message to a group.
// WS-first: tries WS, falls back to REST on failure.
func (c *AICQClient) SendGroupMessage(groupId string, content string) error {
	// Try WS first
	if c.ws.IsConnected() {
		fromID := c.auth.AccountID()
		if err := c.ws.SendGroupMessage(groupId, fromID, content, "text"); err != nil {
			log.Printf("[Messaging] WS group send failed, falling back to REST: %v", err)
		} else {
			return nil
		}
	}

	// REST fallback
	payload := map[string]interface{}{
		"content":  content,
		"msg_type": "text",
	}
	var result interface{}
	path := fmt.Sprintf("/api/v1/groups/%s/messages", groupId)
	return c.auth.AuthPost(path, payload, &result)
}

// GetGroupMessages retrieves messages from a group.
func (c *AICQClient) GetGroupMessages(groupId string, limit int, before string) ([]Message, error) {
	var result struct {
		Messages []Message `json:"messages"`
	}
	path := fmt.Sprintf("/api/v1/groups/%s/messages", groupId)
	// Add query params if provided
	params := []string{}
	if limit > 0 {
		params = append(params, fmt.Sprintf("limit=%d", limit))
	}
	if before != "" {
		params = append(params, "before="+before)
	}
	if len(params) > 0 {
		path += "?" + strings.Join(params, "&")
	}
	if err := c.auth.AuthGet(path, &result); err != nil {
		return nil, fmt.Errorf("get group messages failed: %w", err)
	}
	return result.Messages, nil
}

// ─── Streaming ───

// SendStreamChunk sends a stream chunk to a friend via WS.
func (c *AICQClient) SendStreamChunk(friendID string, chunkType string, data interface{}) error {
	return c.ws.SendStreamChunk(friendID, chunkType, data)
}

// SendStreamChunkWithID sends a stream chunk with a message ID for dedup.
func (c *AICQClient) SendStreamChunkWithID(friendID string, chunkType string, data interface{}, msgID string) error {
	return c.ws.SendStreamChunkWithID(friendID, chunkType, data, msgID)
}

// SendStreamEnd signals the end of a stream to a friend.
func (c *AICQClient) SendStreamEnd(friendID string, messageID string) error {
	return c.ws.SendStreamEnd(friendID, messageID)
}

// SendStreamCancel cancels a stream to a friend.
func (c *AICQClient) SendStreamCancel(friendID string) error {
	return c.ws.SendStreamCancel(friendID)
}

// IsStreamCancelled checks if a stream was cancelled for a friend.
func (c *AICQClient) IsStreamCancelled(friendID string) bool {
	return c.db.IsStreamCancelled(friendID)
}

// ClearStreamCancel clears the stream cancelled state for a friend.
func (c *AICQClient) ClearStreamCancel(friendID string) {
	c.db.ClearStreamCancel(friendID)
}

// SendStreamImage sends an image via WS stream protocol.
func (c *AICQClient) SendStreamImage(friendID string, imageData []byte, mimeType string) error {
	if mimeType == "" {
		mimeType = "image/png"
	}
	b64Data := base64.StdEncoding.EncodeToString(imageData)
	dataURI := fmt.Sprintf("data:%s;base64,%s", mimeType, b64Data)

	if err := c.ws.SendStreamChunk(friendID, "image", dataURI); err != nil {
		return fmt.Errorf("send image chunk failed: %w", err)
	}
	if err := c.ws.SendStreamEnd(friendID, ""); err != nil {
		return fmt.Errorf("send stream_end after image failed: %w", err)
	}
	return nil
}

// ─── File Transfer ───

// UploadFile uploads a file to the AICQ server and returns the URL.
func (c *AICQClient) UploadFile(filePath string, filename string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("read file failed: %w", err)
	}
	if filename == "" {
		filename = filePath
		if idx := strings.LastIndex(filePath, "/"); idx >= 0 {
			filename = filePath[idx+1:]
		}
	}
	mimeType := detectMimeType(data, filename)

	result, err := c.auth.UploadFile(filename, data, mimeType)
	if err != nil {
		return "", fmt.Errorf("upload file failed: %w", err)
	}

	url, _ := result["url"].(string)
	return url, nil
}

// SendFileChunk sends a P2P file chunk to a friend via WS.
func (c *AICQClient) SendFileChunk(friendID string, sessionID string, chunkIndex int, chunkData string) error {
	return c.ws.SendFileChunk(friendID, sessionID, chunkIndex, chunkData)
}

// SendGroupImage sends an image to a group by uploading first, then sending via WS.
func (c *AICQClient) SendGroupImage(groupID string, imageData []byte, mimeType string, fileName string) error {
	const maxUploadSize = 10 * 1024 * 1024 // 10MB

	if len(imageData) > maxUploadSize {
		return fmt.Errorf("image too large for group upload (%d bytes), max 10MB", len(imageData))
	}

	if fileName == "" {
		ext := ".png"
		if strings.Contains(mimeType, "jpeg") || strings.Contains(mimeType, "jpg") {
			ext = ".jpg"
		} else if strings.Contains(mimeType, "gif") {
			ext = ".gif"
		} else if strings.Contains(mimeType, "webp") {
			ext = ".webp"
		}
		fileName = fmt.Sprintf("image_%d%s", time.Now().UnixMilli(), ext)
	}
	if mimeType == "" {
		mimeType = "image/png"
	}

	uploadResult, err := c.auth.UploadFile(fileName, imageData, mimeType)
	if err != nil {
		return fmt.Errorf("upload image to server failed: %w", err)
	}

	mediaURL, _ := uploadResult["url"].(string)
	fileID, _ := uploadResult["id"].(string)
	fileSize := float64(len(imageData))
	if sz, ok := uploadResult["size"].(float64); ok && sz > 0 {
		fileSize = sz
	}
	expiresAt, _ := uploadResult["expires_at"].(string)

	fileInfo := map[string]interface{}{
		"filename":   fileName,
		"size":       int(fileSize),
		"url":        mediaURL,
		"id":         fileID,
		"expires_at": expiresAt,
	}

	contentJSON, _ := json.Marshal(map[string]interface{}{
		"type":       "image",
		"url":        mediaURL,
		"filename":   fileName,
		"size":       int(fileSize),
		"expires_at": expiresAt,
	})

	fromID := c.auth.AccountID()
	if err := c.ws.SendGroupMessageWithMedia(groupID, fromID, string(contentJSON), "image", mediaURL, fileInfo); err != nil {
		return err
	}

	return nil
}

// MarkRead marks messages as read.
func (c *AICQClient) MarkRead(friendID string, messageIDs []string) error {
	payload := map[string]interface{}{
		"friend_id":   friendID,
		"message_ids": messageIDs,
	}
	var result interface{}
	return c.auth.AuthPost("/api/v1/chat/mark-read", payload, &result)
}

// GetConversation retrieves conversation history with a friend.
func (c *AICQClient) GetConversation(friendID string) ([]Message, error) {
	var result struct {
		Messages []Message `json:"messages"`
	}
	path := fmt.Sprintf("/api/v1/chat/conversation/%s", friendID)
	if err := c.auth.AuthGet(path, &result); err != nil {
		return nil, fmt.Errorf("get conversation failed: %w", err)
	}
	return result.Messages, nil
}

// ─── Utility ───

// detectMimeType attempts to detect MIME type from file data and extension.
func detectMimeType(data []byte, filename string) string {
	if len(data) > 0 {
		// Simple heuristic from file extension
		if strings.HasSuffix(strings.ToLower(filename), ".png") {
			return "image/png"
		} else if strings.HasSuffix(strings.ToLower(filename), ".jpg") || strings.HasSuffix(strings.ToLower(filename), ".jpeg") {
			return "image/jpeg"
		} else if strings.HasSuffix(strings.ToLower(filename), ".gif") {
			return "image/gif"
		} else if strings.HasSuffix(strings.ToLower(filename), ".webp") {
			return "image/webp"
		} else if strings.HasSuffix(strings.ToLower(filename), ".pdf") {
			return "application/pdf"
		}
	}
	return "application/octet-stream"
}

// streamMsgID generates a unique message ID for stream deduplication.
func streamMsgID() string {
	return fmt.Sprintf("msg_%d_%s", time.Now().UnixMilli(), randomHex(6))
}

// randomHex generates a random hex string of n bytes (2n hex chars).
func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = randRead(b)
	return fmt.Sprintf("%x", b)
}
