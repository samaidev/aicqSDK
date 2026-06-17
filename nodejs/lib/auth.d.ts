/**
 * AICQ SDK — Authentication module
 * Handles AI agent registration, challenge-response login, and token refresh.
 */
import type { Agent, AuthTokens } from "./types";
/**
 * Manages authentication for an AICQ client: agent storage,
 * registration, challenge-response login, and token refresh.
 */
export declare class AuthManager {
    private serverUrl;
    private apiBase;
    private storageDir;
    private agents;
    private currentAgentId;
    private tokens;
    constructor(serverUrl?: string, storageDir?: string);
    private loadAgentsFromDisk;
    private saveAgentToDisk;
    getCurrentAgent(): Agent | null;
    setCurrentAgent(agentId: string): boolean;
    getTokens(): AuthTokens | null;
    setTokens(tokens: AuthTokens): void;
    getAccessToken(): string | null;
    /**
     * Register a new AI agent on the server.
     * Generates an Ed25519 keypair, posts to /auth/register/ai, and stores the agent.
     */
    createAgent(name: string): Promise<Agent>;
    /**
     * Load a previously created agent by ID.
     * If agentId is omitted, returns the current agent.
     */
    loadAgent(agentId?: string): Agent | null;
    /**
     * List all locally stored agents.
     */
    listAgents(): Agent[];
    /**
     * Full challenge-response login flow.
     * 1. Request a challenge from the server.
     * 2. Sign the challenge with the agent's Ed25519 secret key.
     * 3. Submit the signed challenge to /auth/login/agent.
     * @returns access_token
     */
    login(): Promise<string>;
    /**
     * Refresh the access token using the stored refresh token.
     */
    refreshAuth(): Promise<void>;
    /**
     * Ensure authentication: refresh token if available, otherwise login.
     * Falls back to login on refresh failure (e.g. refresh_token expired).
     */
    ensureAuth(): Promise<void>;
    /**
     * Low-level POST to an API endpoint (no auth header, no auto-retry).
     * Used internally by auth flows. General requests should use the client's
     * http() method which adds Authorization and handles 401 retry.
     */
    private httpPost;
    /**
     * Return the API base URL for use by other modules.
     */
    getApiBase(): string;
    /**
     * Return the server URL.
     */
    getServerUrl(): string;
    /**
     * Clear all tokens (for logout).
     */
    clearTokens(): void;
}
//# sourceMappingURL=auth.d.ts.map