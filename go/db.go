package aicq

import (
	"sync"
)

// ─── In-Memory Local Storage ─────────────────────────────────────
// Optional SQLite storage can be added later; for now we use in-memory maps
// with thread-safe access. This stores agents, tokens, and dedup state.

// LocalDB provides in-memory storage for the SDK.
type LocalDB struct {
	mu       sync.RWMutex
	agents   map[string]*Agent          // agentID -> Agent
	current  string                      // current agent ID
	tokens   map[string]*tokenEntry      // agentID -> token entry
	dedup    *DedupTracker               // message deduplication
	streams  map[string]bool             // friendID -> stream cancelled
}

type tokenEntry struct {
	AccessToken  string
	RefreshToken string
}

// NewLocalDB creates a new in-memory local database.
func NewLocalDB() *LocalDB {
	return &LocalDB{
		agents:  make(map[string]*Agent),
		tokens:  make(map[string]*tokenEntry),
		dedup:   NewDedupTracker(),
		streams: make(map[string]bool),
	}
}

// ─── Agent Storage ───

// SaveAgent stores an agent in the local DB.
func (db *LocalDB) SaveAgent(agent *Agent) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.agents[agent.ID] = agent
}

// LoadAgent loads an agent by ID. Returns nil if not found.
func (db *LocalDB) LoadAgent(agentID string) *Agent {
	db.mu.RLock()
	defer db.mu.RUnlock()
	return db.agents[agentID]
}

// ListAgents returns all stored agents.
func (db *LocalDB) ListAgents() []*Agent {
	db.mu.RLock()
	defer db.mu.RUnlock()
	result := make([]*Agent, 0, len(db.agents))
	for _, a := range db.agents {
		result = append(result, a)
	}
	return result
}

// SetCurrentAgent sets the current active agent ID.
func (db *LocalDB) SetCurrentAgent(agentID string) bool {
	db.mu.Lock()
	defer db.mu.Unlock()
	if _, ok := db.agents[agentID]; !ok {
		return false
	}
	db.current = agentID
	return true
}

// GetCurrentAgent returns the current agent ID.
func (db *LocalDB) GetCurrentAgent() string {
	db.mu.RLock()
	defer db.mu.RUnlock()
	return db.current
}

// ─── Token Storage ───

// SaveTokens stores access and refresh tokens for an agent.
func (db *LocalDB) SaveTokens(agentID, accessToken, refreshToken string) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.tokens[agentID] = &tokenEntry{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}
}

// LoadTokens retrieves stored tokens for an agent.
func (db *LocalDB) LoadTokens(agentID string) (accessToken, refreshToken string, ok bool) {
	db.mu.RLock()
	defer db.mu.RUnlock()
	entry, exists := db.tokens[agentID]
	if !exists {
		return "", "", false
	}
	return entry.AccessToken, entry.RefreshToken, true
}

// ─── Stream Cancel State ───

// SetStreamCancelled marks a stream as cancelled for a friend.
func (db *LocalDB) SetStreamCancelled(friendID string) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.streams[friendID] = true
}

// IsStreamCancelled checks if a stream was cancelled for a friend.
func (db *LocalDB) IsStreamCancelled(friendID string) bool {
	db.mu.RLock()
	defer db.mu.RUnlock()
	return db.streams[friendID]
}

// ClearStreamCancel clears the stream cancelled state for a friend.
func (db *LocalDB) ClearStreamCancel(friendID string) {
	db.mu.Lock()
	defer db.mu.Unlock()
	delete(db.streams, friendID)
}

// ─── Message Deduplication ───
// Ordered list of message IDs; prune at 1000 keeping last 500.

// DedupTracker tracks seen message IDs for deduplication.
type DedupTracker struct {
	mu    sync.RWMutex
	ids   []string           // ordered list of seen IDs
	index map[string]struct{} // fast lookup
}

const (
	dedupPruneAt   = 1000
	dedupKeepAfter = 500
)

// NewDedupTracker creates a new DedupTracker.
func NewDedupTracker() *DedupTracker {
	return &DedupTracker{
		ids:   make([]string, 0),
		index: make(map[string]struct{}),
	}
}

// Has checks if a message ID has been seen before.
func (d *DedupTracker) Has(id string) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	_, ok := d.index[id]
	return ok
}

// Add records a message ID. Prunes when size > 1000, keeping last 500.
func (d *DedupTracker) Add(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if _, ok := d.index[id]; ok {
		return // already seen
	}

	d.ids = append(d.ids, id)
	d.index[id] = struct{}{}

	// Prune when over threshold
	if len(d.ids) > dedupPruneAt {
		// Keep only the last 500
		removed := d.ids[:len(d.ids)-dedupKeepAfter]
		for _, rid := range removed {
			delete(d.index, rid)
		}
		d.ids = d.ids[len(d.ids)-dedupKeepAfter:]
	}
}

// Reset clears all dedup state.
func (d *DedupTracker) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ids = d.ids[:0]
	for k := range d.index {
		delete(d.index, k)
	}
}
