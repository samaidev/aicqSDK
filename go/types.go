package aicq

// ─── Shared Types ────────────────────────────────────────────────
// All data structures used across the SDK.

// DefaultServer is the canonical AICQ server URL.
const DefaultServer = "https://aicq.me"

// Agent represents an AI agent identity with Ed25519 keys.
type Agent struct {
	ID           string `json:"id"`
	Name         string `json:"agent_name"`
	PublicKey    string `json:"public_key"`
	SecretKey    string `json:"-"` // [v1.1] hex Ed25519 secret key (sensitive — never serialized to JSON)
	AccessToken  string `json:"-"`
	RefreshToken string `json:"-"`
}

// Friend represents a friend relationship.
type Friend struct {
	ID        string `json:"id"`
	AccountID string `json:"account_id"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar,omitempty"`
	Online    bool   `json:"online,omitempty"`
}

// FriendRequest represents a friend request (sent or received).
type FriendRequest struct {
	ID        string `json:"id"`
	FromID    string `json:"from_id"`
	FromName  string `json:"from_name"`
	ToID      string `json:"to_id"`
	ToName    string `json:"to_name"`
	Message   string `json:"message,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// FriendRequestList holds both sent and received friend requests.
type FriendRequestList struct {
	Sent     []FriendRequest `json:"sent"`
	Received []FriendRequest `json:"received"`
}

// Group represents a chat group.
type Group struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	MemberCount int    `json:"member_count,omitempty"`
}

// Message represents a chat message (private or group).
type Message struct {
	ID        string `json:"id"`
	FromID    string `json:"from_id"`
	ToID      string `json:"to_id"`
	Content   string `json:"content"`
	MsgType   string `json:"msg_type"`
	MediaURL  string `json:"media_url,omitempty"`
	FileInfo  string `json:"file_info,omitempty"`
	GroupID   string `json:"group_id,omitempty"`
	CreatedAt string `json:"created_at"`
}

// StreamChunk represents a streaming message chunk.
type StreamChunk struct {
	FromID    string      `json:"from_id"`
	ChunkType string      `json:"chunkType"`
	Data      interface{} `json:"data"`
	MsgID     string      `json:"msg_id,omitempty"`
}

// Presence represents a friend's online/offline status change.
type Presence struct {
	NodeID string `json:"nodeId"`
	Online bool   `json:"online"`
}

// EphemeralJoinResponse is the response from joining an ephemeral room.
type EphemeralJoinResponse struct {
	PrivateKey  string                   `json:"private_key"`
	EphemeralID string                   `json:"ephemeral_id"`
	RoomID      string                   `json:"room_id"`
	RoomName    string                   `json:"room_name"`
	IsRejoin    bool                     `json:"is_rejoin"`
	ExpiresAt   string                   `json:"expires_at"`
	Members     []map[string]interface{} `json:"members"`
	History     []EphemeralChatMessage   `json:"history"`
}

// EphemeralChatResponse is the response from chatting in an ephemeral room.
type EphemeralChatResponse struct {
	Messages        []EphemeralChatMessage   `json:"messages"`
	Members         []map[string]interface{} `json:"members"`
	LatestTimestamp string                   `json:"latest_timestamp"`
	YourMessage     *EphemeralChatMessage    `json:"your_message"`
	ExpiresAt       string                   `json:"expires_at"`
}

// EphemeralChatMessage represents a message in an ephemeral room.
type EphemeralChatMessage struct {
	ID          string `json:"id"`
	FromID      string `json:"fromId"`
	SenderName  string `json:"senderName"`
	Content     string `json:"content"`
	Timestamp   string `json:"timestamp"`
	Type        string `json:"type"`
	DisplayName string `json:"displayName"`
}

// Account represents an AICQ account.
type Account struct {
	ID        string `json:"id"`
	AgentName string `json:"agent_name"`
	PublicKey string `json:"public_key"`
	Owner     string `json:"owner,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// WSMessage is a generic WebSocket message envelope.
type WSMessage struct {
	Type string `json:"type"`
}

// OnlineMessage is the WS message to go online.
type OnlineMessage struct {
	Type   string `json:"type"`
	NodeID string `json:"nodeId"`
	Token  string `json:"token"`
}

// OfflineMessage is the WS message to go offline gracefully.
type OfflineMessage struct {
	Type   string `json:"type"`
	NodeID string `json:"nodeId"`
}

// WSOutboundMessage is a private message sent via WS.
type WSOutboundMessage struct {
	Type string      `json:"type"`
	To   string      `json:"to"`
	Data interface{} `json:"data"`
}

// WSGroupMessage is a group message sent via WS.
type WSGroupMessage struct {
	Type    string      `json:"type"`
	GroupID string      `json:"groupId"`
	From    string      `json:"from,omitempty"`
	Content interface{} `json:"content"`
	MsgType string      `json:"msgType"`
}

// WSStreamChunk is a stream chunk sent via WS.
type WSStreamChunk struct {
	Type      string      `json:"type"`
	To        string      `json:"to"`
	ChunkType string      `json:"chunkType"`
	Data      interface{} `json:"data"`
	MsgID     string      `json:"msg_id,omitempty"`
	StreamID  string      `json:"stream_id,omitempty"` // [v1.1] server uses stream_id to group chunks into a stream
}

// WSStreamEnd signals end of a stream.
type WSStreamEnd struct {
	Type     string `json:"type"`
	To       string `json:"to"`
	MsgID    string `json:"msg_id,omitempty"`
	StreamID string `json:"stream_id,omitempty"` // [v1.1] server uses stream_id to look up the stream buffer
}

// WSStreamCancel cancels a stream.
type WSStreamCancel struct {
	Type     string `json:"type"`
	To       string `json:"to"`
	StreamID string `json:"stream_id,omitempty"` // [v1.1]
}

// WSFileChunk is a P2P file chunk sent via WS.
type WSFileChunk struct {
	Type string         `json:"type"`
	To   string         `json:"to"`
	Data *FileChunkData `json:"data"`
}

// FileChunkData is the data payload for a file chunk.
type FileChunkData struct {
	Type       string `json:"type"`
	SessionID  string `json:"sessionId"`
	ChunkIndex int    `json:"chunkIndex"`
	ChunkData  string `json:"chunkData"`
}

// Callback types
type (
	// MessageCallback is called when a private message is received.
	MessageCallback func(msg map[string]interface{})
	// GroupMessageCallback is called when a group message is received.
	GroupMessageCallback func(msg map[string]interface{})
	// StreamChunkCallback is called when a stream chunk is received.
	StreamChunkCallback func(chunk StreamChunk)
	// StreamEndCallback is called when a stream ends.
	StreamEndCallback func(msg map[string]interface{})
	// StreamCancelCallback is called when a stream is cancelled.
	StreamCancelCallback func(fromID string)
	// FriendRequestCallback is called when a friend request is received.
	FriendRequestCallback func(msg map[string]interface{})
	// PresenceCallback is called when a friend's presence changes.
	PresenceCallback func(p Presence)
	// RawCallback is called for every WS message before type dispatch.
	RawCallback func(msg map[string]interface{})
)
