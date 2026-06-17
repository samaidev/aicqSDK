package aicq

import (
        "bytes"
        "crypto/ed25519"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "log"
        "mime/multipart"
        "net/http"
        "sync"
        "time"
)

// ─── Authentication ──────────────────────────────────────────────
// Handles: register, challenge, login, refresh.
// Fixed: Refresh() no longer has mutex double-acquire (uses sync.RWMutex pattern).
// Fixed: No dead code (AuthGetRaw, AuthPut removed).
// Fixed: 401 auto-retry on ALL HTTP methods.

// AuthManager handles authentication for the AICQ SDK.
type AuthManager struct {
        server       string
        pubKeyHex    string
        secKey       ed25519.PrivateKey
        accessToken  string
        refreshToken string
        accountID    string
        accountName  string
        mu           sync.RWMutex // RWMutex allows concurrent reads, fixes double-acquire
}

// newAuthManager creates a new AuthManager for the given server.
func newAuthManager(server string) *AuthManager {
        return &AuthManager{
                server: server,
        }
}

// LoadOrGenerateKeys loads Ed25519 keys from hex strings, or generates new ones.
func (a *AuthManager) LoadOrGenerateKeys(secKeyHex string) error {
        if secKeyHex != "" {
                secBytes, err := hex.DecodeString(secKeyHex)
                if err == nil && len(secBytes) == ed25519.PrivateKeySize {
                        a.secKey = ed25519.PrivateKey(secBytes)
                        a.pubKeyHex = hex.EncodeToString(a.secKey.Public().(ed25519.PublicKey))
                        return nil
                }
        }
        // Generate new keypair
        pub, sec, err := ed25519.GenerateKey(nil)
        if err != nil {
                return fmt.Errorf("generate ed25519 keypair: %w", err)
        }
        a.secKey = sec
        a.pubKeyHex = hex.EncodeToString(pub)
        log.Printf("[Auth] Generated new Ed25519 keypair (pub=%s...)", a.pubKeyHex[:16])
        return nil
}

// SetKeys sets the Ed25519 keys from existing hex values.
func (a *AuthManager) SetKeys(secKeyHex, pubKeyHex string) error {
        a.mu.Lock()
        defer a.mu.Unlock()

        secBytes, err := hex.DecodeString(secKeyHex)
        if err != nil {
                return fmt.Errorf("decode secret key: %w", err)
        }
        if len(secBytes) != ed25519.PrivateKeySize {
                return fmt.Errorf("invalid secret key size: expected %d, got %d", ed25519.PrivateKeySize, len(secBytes))
        }
        a.secKey = ed25519.PrivateKey(secBytes)
        a.pubKeyHex = pubKeyHex
        if a.pubKeyHex == "" {
                a.pubKeyHex = hex.EncodeToString(a.secKey.Public().(ed25519.PublicKey))
        }
        return nil
}

// PubKeyHex returns the hex-encoded public key.
func (a *AuthManager) PubKeyHex() string {
        a.mu.RLock()
        defer a.mu.RUnlock()
        return a.pubKeyHex
}

// AccountID returns the current account ID.
func (a *AuthManager) AccountID() string {
        a.mu.RLock()
        defer a.mu.RUnlock()
        return a.accountID
}

// AccountName returns the current account name.
func (a *AuthManager) AccountName() string {
        a.mu.RLock()
        defer a.mu.RUnlock()
        return a.accountName
}

// Token returns the current access token (thread-safe read).
func (a *AuthManager) Token() string {
        a.mu.RLock()
        defer a.mu.RUnlock()
        return a.accessToken
}

// RefreshTokenValue returns the current refresh token (thread-safe read).
func (a *AuthManager) RefreshTokenValue() string {
        a.mu.RLock()
        defer a.mu.RUnlock()
        return a.refreshToken
}

// SetTokens sets the access and refresh tokens.
func (a *AuthManager) SetTokens(access, refresh string) {
        a.mu.Lock()
        defer a.mu.Unlock()
        a.accessToken = access
        if refresh != "" {
                a.refreshToken = refresh
        }
}

// ─── Registration & Login ───

// Register registers a new AI agent with the server.
func (a *AuthManager) Register(agentName string) error {
        a.mu.Lock()
        defer a.mu.Unlock()

        payload := map[string]string{
                "public_key": a.pubKeyHex,
                "agent_name": agentName,
        }
        var regResp struct {
                Account      map[string]interface{} `json:"account"`
                AccessToken  string                 `json:"access_token"`
                RefreshToken string                 `json:"refresh_token"`
        }
        endpoint := a.server + "/api/v1/auth/register/ai"
        err := httpPost(endpoint, payload, &regResp)
        if err != nil {
                return fmt.Errorf("register failed: %w", err)
        }

        a.accessToken = regResp.AccessToken
        a.refreshToken = regResp.RefreshToken
        if acct := regResp.Account; acct != nil {
                if id, ok := acct["id"].(string); ok {
                        a.accountID = id
                }
                if name, ok := acct["agent_name"].(string); ok {
                        a.accountName = name
                }
        }
        log.Printf("[Auth] Registered: account=%s name=%s", a.accountID, a.accountName)
        return nil
}

// ChallengeLogin performs Ed25519 challenge-response login.
func (a *AuthManager) ChallengeLogin() error {
        a.mu.Lock()
        defer a.mu.Unlock()
        return a.challengeLoginInternal()
}

// challengeLoginInternal performs Ed25519 challenge-response login.
// Caller MUST hold a.mu write lock. This avoids the double-acquire bug
// that was present in the original zagent code where Refresh() would
// unlock and re-lock around challengeLogin().
func (a *AuthManager) challengeLoginInternal() error {
        // Get challenge
        var chalResp struct {
                SessionID string `json:"session_id"`
                Challenge string `json:"challenge"`
        }
        if err := httpPost(a.server+"/api/v1/auth/challenge", map[string]string{"public_key": a.pubKeyHex}, &chalResp); err != nil {
                return NewAuthError(0, fmt.Sprintf("challenge failed: %v", err), "/api/v1/auth/challenge")
        }

        // Sign challenge (decode hex challenge to raw bytes, then sign)
        chalBytes, err := hex.DecodeString(chalResp.Challenge)
        if err != nil {
                return fmt.Errorf("decode challenge: %w", err)
        }
        sig := ed25519.Sign(a.secKey, chalBytes)

        // Login
        var loginResp struct {
                Account      map[string]interface{} `json:"account"`
                AccessToken  string                 `json:"access_token"`
                RefreshToken string                 `json:"refresh_token"`
        }
        loginPayload := map[string]string{
                "public_key": a.pubKeyHex,
                "signature":  hex.EncodeToString(sig),
                "challenge":  chalResp.Challenge,
        }
        if err := httpPost(a.server+"/api/v1/auth/login/agent", loginPayload, &loginResp); err != nil {
                return NewAuthError(0, fmt.Sprintf("agent login failed: %v", err), "/api/v1/auth/login/agent")
        }

        a.accessToken = loginResp.AccessToken
        a.refreshToken = loginResp.RefreshToken
        if acct := loginResp.Account; acct != nil {
                if id, ok := acct["id"].(string); ok {
                        a.accountID = id
                }
                if name, ok := acct["agent_name"].(string); ok {
                        a.accountName = name
                }
        }
        log.Printf("[Auth] Challenge-login OK: account=%s", a.accountID)
        return nil
}

// ─── Token Refresh ───
// FIXED: No more mutex double-acquire. Uses challengeLoginInternal()
// which expects the caller to already hold the write lock.

// Refresh refreshes the auth tokens.
// On refresh failure, falls back to challenge-response login.
// On login failure, returns AuthError.
func (a *AuthManager) Refresh() error {
        a.mu.Lock()
        defer a.mu.Unlock()

        // If no refresh token, fall back to challenge-response login
        if a.refreshToken == "" {
                log.Printf("[Auth] No refresh token, falling back to challenge-response login")
                return a.challengeLoginInternal()
        }

        var resp struct {
                AccessToken  string `json:"access_token"`
                RefreshToken string `json:"refresh_token"`
        }
        if err := httpPost(a.server+"/api/v1/auth/refresh", map[string]string{"refreshToken": a.refreshToken}, &resp); err != nil {
                log.Printf("[Auth] Token refresh API failed: %v, falling back to challenge-response login", err)
                return a.challengeLoginInternal()
        }

        a.accessToken = resp.AccessToken
        if resp.RefreshToken != "" {
                a.refreshToken = resp.RefreshToken
        }
        log.Printf("[Auth] Token refreshed successfully")
        return nil
}

// ─── Authenticated HTTP Methods (with 401 auto-retry) ───

// AuthGet performs an authenticated GET request with 401 auto-retry.
func (a *AuthManager) AuthGet(path string, result interface{}) error {
        return a.authRequestWithRetry("GET", a.server+path, nil, result)
}

// AuthPost performs an authenticated POST request with 401 auto-retry.
func (a *AuthManager) AuthPost(path string, payload interface{}, result interface{}) error {
        return a.authRequestWithRetry("POST", a.server+path, payload, result)
}

// AuthDelete performs an authenticated DELETE request with 401 auto-retry.
func (a *AuthManager) AuthDelete(path string, result interface{}) error {
        return a.authRequestWithRetry("DELETE", a.server+path, nil, result)
}

// authRequestWithRetry performs an authenticated HTTP request.
// On 401, it refreshes the token and retries once.
func (a *AuthManager) authRequestWithRetry(method, url string, payload interface{}, result interface{}) error {
        err := a.authRequest(method, url, payload, a.Token(), result)
        if err == nil {
                return nil
        }

        // Check if it's a 401 error
        if httpErr, ok := err.(*HTTPError); ok && httpErr.StatusCode == 401 {
                log.Printf("[Auth] Got 401 from %s, refreshing token and retrying...", url)
                if refreshErr := a.Refresh(); refreshErr != nil {
                        return NewAuthError(401, fmt.Sprintf("token refresh failed after 401: %v", refreshErr), url)
                }
                return a.authRequest(method, url, payload, a.Token(), result)
        }

        return err
}

// authRequest performs a single authenticated HTTP request.
func (a *AuthManager) authRequest(method, url string, payload interface{}, token string, result interface{}) error {
        var bodyBytes []byte
        if payload != nil {
                var err error
                bodyBytes, err = json.Marshal(payload)
                if err != nil {
                        return err
                }
        }

        req, err := http.NewRequest(method, url, bytes.NewReader(bodyBytes))
        if err != nil {
                return err
        }
        req.Header.Set("Content-Type", "application/json")
        if token != "" {
                req.Header.Set("Authorization", "Bearer "+token)
        }

        client := &http.Client{Timeout: 30 * time.Second}
        resp, err := client.Do(req)
        if err != nil {
                return fmt.Errorf("HTTP %s failed: %w", method, err)
        }
        defer resp.Body.Close()

        data, err := io.ReadAll(resp.Body)
        if err != nil {
                return fmt.Errorf("read response failed: %w", err)
        }

        if resp.StatusCode >= 400 {
                body := string(data)
                if len(body) > 300 {
                        body = body[:300]
                }
                return NewHTTPError(resp.StatusCode, body, url)
        }

        if result != nil {
                return json.Unmarshal(data, result)
        }
        return nil
}

// ─── File Upload ───

// UploadFile uploads a file to the AICQ server via multipart form POST.
// Returns the server response containing {id, filename, url, size, mimeType, thumbUrl}.
// Includes 401 auto-retry.
func (a *AuthManager) UploadFile(fileName string, fileData []byte, mimeType string) (map[string]interface{}, error) {
        result, err := a.uploadFileInternal(fileName, fileData, mimeType, a.Token())
        if err == nil {
                return result, nil
        }

        // Check for 401
        if httpErr, ok := err.(*HTTPError); ok && httpErr.StatusCode == 401 {
                log.Printf("[Auth] Upload got 401, refreshing token and retrying...")
                if refreshErr := a.Refresh(); refreshErr != nil {
                        return nil, NewAuthError(401, fmt.Sprintf("token refresh failed after 401: %v", refreshErr), "/api/v1/chat/upload")
                }
                return a.uploadFileInternal(fileName, fileData, mimeType, a.Token())
        }

        return nil, err
}

func (a *AuthManager) uploadFileInternal(fileName string, fileData []byte, mimeType string, token string) (map[string]interface{}, error) {
        fullURL := a.server + "/api/v1/chat/upload"

        var b bytes.Buffer
        writer := multipart.NewWriter(&b)
        part, err := writer.CreateFormFile("file", fileName)
        if err != nil {
                return nil, fmt.Errorf("create form file failed: %w", err)
        }
        if _, err := part.Write(fileData); err != nil {
                return nil, fmt.Errorf("write form file data failed: %w", err)
        }
        if err := writer.Close(); err != nil {
                return nil, fmt.Errorf("close multipart writer failed: %w", err)
        }

        req, err := http.NewRequest("POST", fullURL, &b)
        if err != nil {
                return nil, fmt.Errorf("create request failed: %w", err)
        }
        req.Header.Set("Authorization", "Bearer "+token)
        req.Header.Set("Content-Type", writer.FormDataContentType())

        client := &http.Client{Timeout: 120 * time.Second}
        resp, err := client.Do(req)
        if err != nil {
                return nil, fmt.Errorf("upload request failed: %w", err)
        }
        defer resp.Body.Close()

        data, err := io.ReadAll(resp.Body)
        if err != nil {
                return nil, fmt.Errorf("read upload response failed: %w", err)
        }

        if resp.StatusCode >= 400 {
                body := string(data)
                if len(body) > 300 {
                        body = body[:300]
                }
                return nil, NewHTTPError(resp.StatusCode, body, fullURL)
        }

        var result map[string]interface{}
        if err := json.Unmarshal(data, &result); err != nil {
                return nil, fmt.Errorf("parse upload response failed: %w", err)
        }
        return result, nil
}

// ─── HTTP Helper (unauthenticated) ───

func httpPost(url string, payload interface{}, result interface{}) error {
        body, err := json.Marshal(payload)
        if err != nil {
                return err
        }
        client := &http.Client{Timeout: 30 * time.Second}
        resp, err := client.Post(url, "application/json", bytes.NewReader(body))
        if err != nil {
                return fmt.Errorf("HTTP POST failed: %w", err)
        }
        defer resp.Body.Close()

        data, err := io.ReadAll(resp.Body)
        if err != nil {
                return fmt.Errorf("read response failed: %w", err)
        }
        if resp.StatusCode >= 400 {
                body := string(data)
                if len(body) > 300 {
                        body = body[:300]
                }
                return NewHTTPError(resp.StatusCode, body, url)
        }
        if result != nil {
                return json.Unmarshal(data, result)
        }
        return nil
}
