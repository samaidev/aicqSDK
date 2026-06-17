package aicq

// zagent_extensions.go — 给 AICQClient 添加 zagent 重构需要的扩展方法
//
// 这些方法是为了让 zagent 能从自实现 (room.go + tools_aicq.go + auth.go + ws.go)
// 平滑迁移到 Go SDK。每个方法都对应 zagent 现有调用面的一个或多个需求。
//
// 已有但可复用的 SDK 方法 (不需要扩展):
//   - AuthManager.AuthGet / AuthPost / AuthDelete  (公开, 支持 401 自动重试)
//   - AuthManager.UploadFile
//   - AuthManager.Token / AccountID / PubKeyHex / SetTokens / SetKeys / LoadOrGenerateKeys
//   - AICQClient.ImportAgent (从 hex 私钥+token 导入身份, 适合 zagent 已有 key 文件)
//   - AICQClient.IsConnected
//   - AICQClient.OnRaw (接住所有未类型化的 WS 事件)
//   - AICQClient.SendStreamChunkWithID / SendStreamEnd / SendStreamCancel
//   - AICQClient.SendGroupImage / SendStreamImage
//
// 本文件新增方法:
//   - SendGroupFile: 群文件发送 (SDK 原本只有 SendGroupImage)
//   - Broadcast: 平台广播 (端点 /api/v1/broadcast, SPEC 有, SDK 没实现)
//   - GetConversationWithLimit: 带分页的会话历史 (SDK 的 GetConversation 无 limit)
//   - WaitForConnected: 阻塞等待 WS 连接 (替代 zagent 的 WaitForWS)
//   - SetOnReconnect: 设置重连回调 (zagent 用来触发 fetchUnreadMessages)
//   - SendMessageREST: REST-only 私聊发送 (保持 zagent toolSendPrivateMessage 原行为)
//   - DownloadFile: 媒体文件下载 (端点 /api/v1/chat/files/{id}?token=...)
//   - GetMessageByID: 单条消息刷新 (端点 /api/v1/chat/messages/{id})
//   - SendGroupMessageWithMedia: 直接调用 (zagent ws.go:220)
//   - SendFileInfo: P2P 文件元信息 (zagent ws.go:445 的 file_info PM)
//   - AuthGet/Post/Delete (在 AICQClient 上的转发, 便于 zagent 切换)

import (
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "sync"
        "time"
)

// ─── AICQClient 通用 HTTP 方法转发 (供 zagent 调用未封装端点) ────────

// AuthGet 在 AICQClient 上的转发方法, 便于 zagent 调用任意 GET 端点。
// result 必须是指针或 *map[string]interface{}。
// 内部自动 401 重试 (Refresh + 重新登录)。
func (c *AICQClient) AuthGet(path string, result interface{}) error {
        return c.auth.AuthGet(path, result)
}

// AuthPost 在 AICQClient 上的转发方法。
func (c *AICQClient) AuthPost(path string, payload interface{}, result interface{}) error {
        return c.auth.AuthPost(path, payload, result)
}

// AuthDelete 在 AICQClient 上的转发方法。
func (c *AICQClient) AuthDelete(path string, result interface{}) error {
        return c.auth.AuthDelete(path, result)
}

// AuthUploadFile 在 AICQClient 上的转发方法 (multipart 上传)。
// 返回值是 server 响应 JSON (含 url 字段)。
func (c *AICQClient) AuthUploadFile(fileName string, fileData []byte, mimeType string) (map[string]interface{}, error) {
        return c.auth.UploadFile(fileName, fileData, mimeType)
}

// ─── WS 状态: 暴露给 zagent 的 server URL 和 token (媒体下载用) ────

// ServerURL 返回当前配置的 AICQ 服务器 URL (含 https:// 前缀)。
func (c *AICQClient) ServerURL() string {
        return c.server
}

// AccessToken 返回当前 access_token, 便于 zagent 拼接媒体下载 URL。
func (c *AICQClient) AccessToken() string {
        return c.auth.Token()
}

// ─── WaitForConnected ──────────────────────────────────────────────

// WaitForConnected 阻塞等待 WS 连接建立, 超时返回 error。
// 替代 zagent ws.go 的 WaitForWS(timeout) 方法。
//
// 用于流式回复场景: zagent 在 agent.go:2563/2613/2676 调用 WaitForWS(30s),
// 等 WS 恢复后再发 stream_chunk。
func (c *AICQClient) WaitForConnected(timeout time.Duration) error {
        deadline := time.Now().Add(timeout)
        ticker := time.NewTicker(100 * time.Millisecond)
        defer ticker.Stop()

        for {
                if c.IsConnected() {
                        return nil
                }
                if time.Now().After(deadline) {
                        return fmt.Errorf(" WaitForConnected: timeout after %v", timeout)
                }
                select {
                case <-ticker.C:
                case <-time.After(50 * time.Millisecond):
                }
        }
}

// ─── SetOnReconnect ────────────────────────────────────────────────

// SetOnReconnect 注册 WS 重连成功后的回调。
// zagent 用它来触发 fetchUnreadMessages / fetchGroupIncrementalUpdates。
// 必须在 Connect() 之前调用。
//
// NOTE: This sets BOTH AICQClient.onReconnect AND WSManager.onReconnect
// (the latter was added in v1.2.0 so the auto-reconnect path inside
// readLoop fires the callback). Calling this method before Connect()
// ensures the callback fires on:
//   - Initial successful connect (via ConnectWithRetry)
//   - Auto-reconnect after unexpected disconnect (via readLoop → ReconnectLoop)
//   - Explicit ReconnectLoop calls
func (c *AICQClient) SetOnReconnect(cb func()) {
        c.onReconnect = cb
        c.ws.SetOnReconnect(cb)
}

// ─── ConnectWithRetry ──────────────────────────────────────────────

// ConnectWithRetry 阻塞直到 WS 连接建立, 失败时指数退避重试。
// 这是 zagent 完全迁移到 SDK WS 后用来替代 legacy ConnectWS 的入口。
//
// 与 Connect() 的区别:
//   - Connect() 只尝试一次, 失败立即返回 error
//   - ConnectWithRetry() 无限重试 (直到 stopCh 关闭), 模仿 legacy
//     ConnectWS 的 for-loop 行为
//
// 调用前必须先 EnsureAuth (有 access token)。
// 通常在 goroutine 中调用: go sdk.ConnectWithRetry()
func (c *AICQClient) ConnectWithRetry() error {
        if err := c.EnsureAuth(); err != nil {
                return fmt.Errorf("auth required before connect: %w", err)
        }
        return c.ws.ConnectWithRetry()
}

// ─── SendMessageREST ───────────────────────────────────────────────

// SendMessageREST 通过 REST API (而非 WebSocket) 发送私聊消息。
// 适合 zagent toolSendPrivateMessage 的原行为 (REST-only, 不发 WS)。
//
// 端点: POST /api/v1/chat/messages
func (c *AICQClient) SendMessageREST(friendID string, content string) (map[string]interface{}, error) {
        payload := map[string]interface{}{
                "to_id":   friendID,
                "content": content,
                "type":    "text",
        }
        var result map[string]interface{}
        if err := c.auth.AuthPost("/api/v1/chat/messages", payload, &result); err != nil {
                return nil, err
        }
        return result, nil
}

// ─── GetConversationWithLimit ──────────────────────────────────────

// GetConversationWithLimit 获取与好友的聊天历史, 支持分页。
// 端点: GET /api/v1/chat/conversation/{friendId}?limit=N
//
// SDK 内置的 GetConversation 无 limit 参数, 此方法补全。
func (c *AICQClient) GetConversationWithLimit(friendID string, limit int) (map[string]interface{}, error) {
        path := fmt.Sprintf("/api/v1/chat/conversation/%s?limit=%d", friendID, limit)
        var result map[string]interface{}
        if err := c.auth.AuthGet(path, &result); err != nil {
                return nil, err
        }
        return result, nil
}

// ─── Broadcast ─────────────────────────────────────────────────────

// Broadcast 向所有用户发送平台广播消息 (AI agent 专用, 通常需 owner 权限)。
// 端点: POST /api/v1/broadcast
//
// SPEC 中存在此端点, 但 SDK 之前未实现。
func (c *AICQClient) Broadcast(content string, msgType string) (map[string]interface{}, error) {
        if msgType == "" {
                msgType = "text"
        }
        payload := map[string]interface{}{
                "content":  content,
                "msg_type": msgType,
        }
        var result map[string]interface{}
        if err := c.auth.AuthPost("/api/v1/broadcast", payload, &result); err != nil {
                return nil, err
        }
        return result, nil
}

// ─── DownloadFile (媒体下载) ───────────────────────────────────────

// DownloadFile 下载 AICQ 服务器上的媒体文件。
// 端点: GET /api/v1/chat/files/{fileId}?token=...
//
// 注意: 此端点不在 SPEC.md 中, 但 zagent 在 agent.go:428-470 大量使用。
// token 必须作为 query 参数 (不能放 header), 否则服务器拒绝。
//
// 返回原始字节流, 由调用方决定如何处理 (base64 编码 / 写文件)。
func (c *AICQClient) DownloadFile(fileID string) ([]byte, string, error) {
        token := c.auth.Token()
        url := fmt.Sprintf("%s/api/v1/chat/files/%s?token=%s", c.server, fileID, token)

        resp, err := http.Get(url)
        if err != nil {
                return nil, "", fmt.Errorf("download failed: %w", err)
        }
        defer resp.Body.Close()

        if resp.StatusCode != http.StatusOK {
                body, _ := io.ReadAll(resp.Body)
                return nil, "", fmt.Errorf("download failed: HTTP %d: %s",
                        resp.StatusCode, string(body[:min(len(body), 200)]))
        }

        data, err := io.ReadAll(resp.Body)
        if err != nil {
                return nil, "", fmt.Errorf("read body failed: %w", err)
        }

        return data, resp.Header.Get("Content-Type"), nil
}

// ─── GetMessageByID ────────────────────────────────────────────────

// GetMessageByID 获取单条消息的元信息 (含最新 media_url)。
// 端点: GET /api/v1/chat/messages/{messageId}
//
// 注意: 此端点不在 SPEC.md 中, 但 zagent 在 agent.go:3189 用于媒体上传后刷新消息。
func (c *AICQClient) GetMessageByID(messageID string) (map[string]interface{}, error) {
        path := fmt.Sprintf("/api/v1/chat/messages/%s", messageID)
        var result map[string]interface{}
        if err := c.auth.AuthGet(path, &result); err != nil {
                return nil, err
        }
        return result, nil
}

// ─── SendGroupFile ─────────────────────────────────────────────────

// SendGroupFile 向群组发送文件 (与 SendGroupImage 类似, 但 msgType = "file")。
// 内部流程: UploadFile → WS group_message with media_url + file_info。
//
// 端点:
//   - 上传: POST /api/v1/chat/upload (multipart)
//   - 推送: WS type=group_message, msgType=file, media_url=..., file_info=...
//
// zagent 现有 SendGroupFile (ws.go:307) 自实现, 此方法替换之。
func (c *AICQClient) SendGroupFile(groupID string, fileName string, fileData []byte, mimeType string) error {
        // 1. 上传文件到服务器
        uploadResp, err := c.auth.UploadFile(fileName, fileData, mimeType)
        if err != nil {
                return fmt.Errorf("upload failed: %w", err)
        }

        mediaURL, _ := uploadResp["url"].(string)
        if mediaURL == "" {
                return fmt.Errorf("upload response missing 'url' field: %v", uploadResp)
        }

        // 2. 通过 WS 发送 group_message with media
        fileInfo := map[string]interface{}{
                "name":      fileName,
                "size":      len(fileData),
                "mime_type": mimeType,
                "url":       mediaURL,
        }

        msg := map[string]interface{}{
                "type":      "group_message",
                "groupId":   groupID,
                "msgType":   "file",
                "media_url": mediaURL,
                "file_info": fileInfo,
        }

        return c.ws.sendWSJSON(msg)
}

// ─── SendGroupMessageWithMedia ─────────────────────────────────────

// SendGroupMessageWithMedia 发送带媒体附件的群消息 (任意类型)。
// msgType 可以是 "image" / "file" / "audio" / "video" 等。
//
// 这是 zagent ws.go:220 的 SendGroupMessageWithMedia 的 SDK 等价方法。
func (c *AICQClient) SendGroupMessageWithMedia(groupID string, msgType string, content string,
        mediaURL string, fileInfo map[string]interface{}) error {

        msg := map[string]interface{}{
                "type":      "group_message",
                "groupId":   groupID,
                "msgType":   msgType,
                "content":   content,
                "media_url": mediaURL,
        }
        if fileInfo != nil {
                msg["file_info"] = fileInfo
        }

        return c.ws.sendWSJSON(msg)
}

// ─── SendFileInfo (P2P 文件元信息) ─────────────────────────────────

// SendFileInfo 通过 WS 发送 P2P 文件传输的元信息 (file_info)。
// 接收方收到后会准备接收后续的 file_chunk 消息。
//
// 这是 zagent ws.go:445 的 file_info PM 的 SDK 等价方法。
// 通常调用顺序: SendFileInfo → 多次 SendFileChunk → 直到所有分块发完。
func (c *AICQClient) SendFileInfo(friendID string, sessionID string, fileName string,
        fileSize int64, mimeType string, totalChunks int) error {

        msg := map[string]interface{}{
                "type": "message",
                "to":   friendID,
                "msg_type": "file_info",
                "data": map[string]interface{}{
                        "session_id":   sessionID,
                        "file_name":    fileName,
                        "file_size":    fileSize,
                        "mime_type":    mimeType,
                        "total_chunks": totalChunks,
                },
        }
        return c.ws.sendWSJSON(msg)
}

// ─── 关键字 Protect (防止 sync 包被未使用导入) ────────────────────

var _ = sync.Mutex{}

// ─── 辅助: min (Go <1.21 没有) ─────────────────────────────────────

func min(a, b int) int {
        if a < b {
                return a
        }
        return b
}

// ─── 辅助: 序列化消息为 JSON 字符串 (调试用) ───────────────────────

// MarshalJSON 把任意 map 序列化为 JSON 字符串, 失败返回空串。
// 用于 zagent tool 函数返回 string 给 LLM 的场景。
func MarshalJSON(v interface{}) string {
        b, err := json.Marshal(v)
        if err != nil {
                return ""
        }
        return string(b)
}
