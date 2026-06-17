package aicq

import (
        "crypto/ed25519"
        "encoding/hex"
        "fmt"
        "log"
        "sync"
)

// ─── AICQClient ──────────────────────────────────────────────────
// Main SDK class. Aggregates auth, ws, db, and provides the full
// SDK interface as defined in SPEC.md.
//
// Key fixes vs zagent:
//   - Refresh() mutex double-acquire: fixed (sync.RWMutex + internal methods)
//   - Dead code removed: AuthGetRaw, AuthPut, WaitForWS, IsWSConnected
//   - Hardcoded server URLs: fixed (configurable default)
//   - 401 auto-retry: added to ALL HTTP methods
//   - Graceful disconnect: sends {"type":"offline","nodeId":"..."}
//   - Message dedup: ordered list, prune at 1000 keeping last 500
//   - Exponential backoff reconnection: 1s, 2s, 4s, ... max 60s

// AICQClient is the main SDK client.
type AICQClient struct {
        server string
        auth   *AuthManager
        ws     *WSManager
        db     *LocalDB

        mu sync.Mutex

        // Reconnect callback
        onReconnect func()
}

// NewAICQClient creates a new AICQClient.
// serverURL is optional; defaults to "https://aicq.me".
func NewAICQClient(serverURL string) *AICQClient {
        if serverURL == "" {
                serverURL = DefaultServer
        }
        db := NewLocalDB()
        auth := newAuthManager(serverURL)
        ws := newWSManager(auth, serverURL, db.dedup)

        client := &AICQClient{
                server: serverURL,
                auth:   auth,
                ws:     ws,
                db:     db,
        }

        // Set up internal callbacks
        ws.OnStreamCancel(func(fromID string) {
                db.SetStreamCancelled(fromID)
        })

        return client
}

// ─── Identity & Auth ───

// CreateAgent creates a new AI agent identity (generates Ed25519 keypair,
// registers with server, and stores locally).
func (c *AICQClient) CreateAgent(name string) (*Agent, error) {
        if err := c.auth.LoadOrGenerateKeys(""); err != nil {
                return nil, fmt.Errorf("generate keys: %w", err)
        }
        if err := c.auth.Register(name); err != nil {
                // Fallback: try challenge-response login if register fails
                if loginErr := c.auth.ChallengeLogin(); loginErr != nil {
                        return nil, fmt.Errorf("register and login both failed: register=%v login=%v", err, loginErr)
                }
        }

        agent := &Agent{
                ID:           c.auth.AccountID(),
                Name:         c.auth.AccountName(),
                PublicKey:    c.auth.PubKeyHex(),
                AccessToken:  c.auth.Token(),
                RefreshToken: c.auth.RefreshTokenValue(),
        }
        c.db.SaveAgent(agent)
        c.db.SetCurrentAgent(agent.ID)
        c.db.SaveTokens(agent.ID, agent.AccessToken, agent.RefreshToken)

        return agent, nil
}

// LoadAgent loads a stored agent by ID. Returns nil if not found.
func (c *AICQClient) LoadAgent(agentID string) *Agent {
        return c.db.LoadAgent(agentID)
}

// ImportAgent injects an existing agent identity (Ed25519 keys + tokens)
// into the SDK client without going through CreateAgent/Login.
//
// This is the primary entry point for integrators (e.g. zagent) that
// already maintain their own key file format and have valid tokens.
// After ImportAgent, all SDK methods (RefreshAuth, Connect, SendMessage,
// etc.) will use the injected identity.
//
// Parameters:
//   - agentID:       server-assigned account ID
//   - agentName:     display name (optional, can be "")
//   - secKeyHex:     128-char Ed25519 private key hex
//   - pubKeyHex:     64-char Ed25519 public key hex
//   - accessToken:   current JWT access token (can be "" to force refresh)
//   - refreshToken:  current JWT refresh token
//
// Returns the constructed Agent for downstream use.
func (c *AICQClient) ImportAgent(
        agentID, agentName, secKeyHex, pubKeyHex, accessToken, refreshToken string,
) (*Agent, error) {
        // Inject keys into auth manager
        if err := c.auth.SetKeys(secKeyHex, pubKeyHex); err != nil {
                return nil, fmt.Errorf("import keys: %w", err)
        }
        // Inject account info + tokens
        //
        // CRITICAL: SetAccountInfo must be called so that AuthManager.AccountID()
        // returns the correct value. WSManager.Connect() uses AccountID() as the
        // nodeId for the "online" WS message; if it's empty, the AICQ server
        // cannot match the connection to an account and the agent will appear
        // offline on the AICQ client (aicq.me/chat).
        c.auth.SetAccountInfo(agentID, agentName)
        c.auth.SetTokens(accessToken, refreshToken)
        agent := &Agent{
                ID:           agentID,
                Name:         agentName,
                PublicKey:    pubKeyHex,
                AccessToken:  accessToken,
                RefreshToken: refreshToken,
        }
        c.db.SaveAgent(agent)
        c.db.SetCurrentAgent(agentID)
        c.db.SaveTokens(agentID, accessToken, refreshToken)
        return agent, nil
}

// ListAgents returns all stored agents.
func (c *AICQClient) ListAgents() []*Agent {
        return c.db.ListAgents()
}

// SetCurrentAgent sets the current active agent. Returns false if not found.
func (c *AICQClient) SetCurrentAgent(agentID string) bool {
        agent := c.db.LoadAgent(agentID)
        if agent == nil {
                return false
        }
        if !c.db.SetCurrentAgent(agentID) {
                return false
        }
        // Restore tokens
        accessToken, refreshToken, ok := c.db.LoadTokens(agentID)
        if ok {
                c.auth.SetTokens(accessToken, refreshToken)
        }
        // Restore account info (ID + name) so that WSManager.Connect() can
        // send the correct nodeId in the "online" WS message. Without this,
        // switching agents would leave AuthManager.accountID stale and the
        // agent would appear offline on the AICQ client.
        c.auth.SetAccountInfo(agent.ID, agent.Name)
        return true
}

// Login performs authentication. Tries refresh first, then challenge-response login.
// Returns the access token.
func (c *AICQClient) Login() (string, error) {
        if err := c.auth.Refresh(); err != nil {
                if loginErr := c.auth.ChallengeLogin(); loginErr != nil {
                        return "", NewAuthError(0, fmt.Sprintf("login failed: refresh=%v login=%v", err, loginErr), "/api/v1/auth/login/agent")
                }
        }
        token := c.auth.Token()
        if token == "" {
                return "", NewAuthError(0, "login returned empty token", "/api/v1/auth/login/agent")
        }

        // Update stored tokens
        if id := c.auth.AccountID(); id != "" {
                c.db.SaveTokens(id, token, c.auth.RefreshTokenValue())
        }

        return token, nil
}

// RefreshAuth refreshes the authentication tokens.
func (c *AICQClient) RefreshAuth() error {
        return c.auth.Refresh()
}

// EnsureAuth ensures we have valid authentication.
// If no token, tries login. If that fails and we have keys, tries register+login.
func (c *AICQClient) EnsureAuth() error {
        if c.auth.Token() != "" {
                return nil
        }
        // Try login first
        if _, err := c.Login(); err == nil {
                return nil
        }
        // Try register + login
        if _, err := c.CreateAgent("ai-agent"); err != nil {
                return fmt.Errorf("ensure auth failed: %w", err)
        }
        return nil
}

// ─── WebSocket ───

// Connect establishes the WebSocket connection.
func (c *AICQClient) Connect() error {
        if err := c.EnsureAuth(); err != nil {
                return fmt.Errorf("auth required before connect: %w", err)
        }
        return c.ws.Connect()
}

// Disconnect gracefully closes the WebSocket connection.
// Sends {"type":"offline","nodeId":"..."} before closing.
func (c *AICQClient) Disconnect() {
        c.ws.Disconnect()
}

// IsConnected returns whether the WS connection is active.
func (c *AICQClient) IsConnected() bool {
        return c.ws.IsConnected()
}

// Listen blocks until the WebSocket is disconnected.
func (c *AICQClient) Listen() {
        select {
        case <-c.ws.doneCh:
                return
        }
}

// ─── Callbacks ───

// OnMessage registers a callback for incoming private messages.
func (c *AICQClient) OnMessage(cb MessageCallback) {
        c.ws.OnMessage(cb)
}

// OnGroupMessage registers a callback for incoming group messages.
func (c *AICQClient) OnGroupMessage(cb GroupMessageCallback) {
        c.ws.OnGroupMessage(cb)
}

// OnStreamChunk registers a callback for incoming stream chunks.
func (c *AICQClient) OnStreamChunk(cb StreamChunkCallback) {
        c.ws.OnStreamChunk(cb)
}

// OnStreamEnd registers a callback for stream end events.
func (c *AICQClient) OnStreamEnd(cb StreamEndCallback) {
        c.ws.OnStreamEnd(cb)
}

// OnStreamCancel registers a callback for stream cancel events.
func (c *AICQClient) OnStreamCancel(cb StreamCancelCallback) {
        c.ws.OnStreamCancel(cb)
}

// OnFriendRequest registers a callback for friend request events.
func (c *AICQClient) OnFriendRequest(cb FriendRequestCallback) {
        c.ws.OnFriendRequest(cb)
}

// OnPresence registers a callback for presence change events.
func (c *AICQClient) OnPresence(cb PresenceCallback) {
        c.ws.OnPresence(cb)
}

// OnRaw registers a callback that fires for every WS message before type dispatch.
func (c *AICQClient) OnRaw(cb RawCallback) {
        c.ws.OnRaw(cb)
}

// ─── Groups ───

// ListGroups returns the list of groups.
func (c *AICQClient) ListGroups() ([]Group, error) {
        var result struct {
                Groups []Group `json:"groups"`
        }
        if err := c.auth.AuthGet("/api/v1/groups", &result); err != nil {
                return nil, fmt.Errorf("list groups failed: %w", err)
        }
        return result.Groups, nil
}

// CreateGroup creates a new group.
func (c *AICQClient) CreateGroup(name string, description string) (*Group, error) {
        payload := map[string]interface{}{
                "name": name,
        }
        if description != "" {
                payload["description"] = description
        }
        var result struct {
                Group Group `json:"group"`
        }
        if err := c.auth.AuthPost("/api/v1/groups", payload, &result); err != nil {
                return nil, fmt.Errorf("create group failed: %w", err)
        }
        return &result.Group, nil
}

// InviteGroupMember invites a member to a group.
func (c *AICQClient) InviteGroupMember(groupId string, accountId string) error {
        payload := map[string]interface{}{
                "account_id": accountId,
        }
        var result interface{}
        path := fmt.Sprintf("/api/v1/groups/%s/members", groupId)
        return c.auth.AuthPost(path, payload, &result)
}

// ─── Ephemeral Rooms ───

// JoinEphemeralRoom joins an ephemeral room using an invite code.
func (c *AICQClient) JoinEphemeralRoom(inviteCode string, displayName string, privateKey string) (*EphemeralJoinResponse, error) {
        ephemeralClient := NewEphemeralClient(c.server)
        return ephemeralClient.Join(inviteCode, displayName, privateKey)
}

// ─── Accounts ───

// GetAccount returns the current account info.
func (c *AICQClient) GetAccount() (*Account, error) {
        var result Account
        if err := c.auth.AuthGet("/api/v1/accounts/me", &result); err != nil {
                return nil, fmt.Errorf("get account failed: %w", err)
        }
        return &result, nil
}

// LookupByPublicKey looks up an account by its public key.
func (c *AICQClient) LookupByPublicKey(publicKey string) (*Account, error) {
        var result Account
        path := fmt.Sprintf("/api/v1/accounts/lookup?public_key=%s", publicKey)
        if err := c.auth.AuthGet(path, &result); err != nil {
                return nil, fmt.Errorf("lookup failed: %w", err)
        }
        return &result, nil
}

// ─── Owner ───

// SetOwner sets the owner of the current agent.
func (c *AICQClient) SetOwner(ownerID string) (map[string]interface{}, error) {
        payload := map[string]interface{}{
                "owner_id": ownerID,
        }
        var result map[string]interface{}
        if err := c.auth.AuthPost("/api/v1/accounts/owner", payload, &result); err != nil {
                return nil, fmt.Errorf("set owner failed: %w", err)
        }
        return result, nil
}

// GetOwner returns the owner of the current agent.
func (c *AICQClient) GetOwner() (map[string]interface{}, error) {
        var result map[string]interface{}
        if err := c.auth.AuthGet("/api/v1/accounts/owner", &result); err != nil {
                return nil, fmt.Errorf("get owner failed: %w", err)
        }
        return result, nil
}

// ─── Temp Numbers ───

// ResolveTempNumber resolves a temporary number to an account.
func (c *AICQClient) ResolveTempNumber(number string) (map[string]interface{}, error) {
        var result map[string]interface{}
        path := fmt.Sprintf("/api/v1/temp-number/%s", number)
        if err := c.auth.AuthGet(path, &result); err != nil {
                return nil, fmt.Errorf("resolve temp number failed: %w", err)
        }
        return result, nil
}

// RequestTempNumber requests a new temporary number for the current agent.
func (c *AICQClient) RequestTempNumber() (string, error) {
        var result struct {
                Number string `json:"number"`
        }
        if err := c.auth.AuthPost("/api/v1/temp-number", map[string]interface{}{}, &result); err != nil {
                return "", fmt.Errorf("request temp number failed: %w", err)
        }
        return result.Number, nil
}

// ─── Utility ───

// GetStatus returns the current client status.
func (c *AICQClient) GetStatus() map[string]interface{} {
        return map[string]interface{}{
                "server":     c.server,
                "account_id": c.auth.AccountID(),
                "connected":  c.ws.IsConnected(),
                "has_token":  c.auth.Token() != "",
        }
}

// Close performs full cleanup: disconnect WS, close session.
func (c *AICQClient) Close() {
        c.ws.Disconnect()
        log.Printf("[AICQ] Client closed")
}

// ─── Key Import Helpers ───

// ImportSigningKey creates an ed25519.PrivateKey from a hex-encoded secret key.
func ImportSigningKey(secKeyHex string) (ed25519.PrivateKey, error) {
        secBytes, err := hex.DecodeString(secKeyHex)
        if err != nil {
                return nil, fmt.Errorf("decode secret key: %w", err)
        }
        if len(secBytes) != ed25519.PrivateKeySize {
                return nil, fmt.Errorf("invalid secret key size: expected %d, got %d", ed25519.PrivateKeySize, len(secBytes))
        }
        return ed25519.PrivateKey(secBytes), nil
}

// ExportPublicKey extracts and hex-encodes the public key from an ed25519.PrivateKey.
func ExportPublicKey(secKey ed25519.PrivateKey) string {
        return hex.EncodeToString(secKey.Public().(ed25519.PublicKey))
}
