"use strict";
/**
 * AICQ SDK — Authentication module
 * Handles AI agent registration, challenge-response login, and token refresh.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const errors_1 = require("./errors");
const crypto_1 = require("./crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Default base URL for the AICQ REST API. */
const DEFAULT_SERVER = "https://aicq.me";
/**
 * Manages authentication for an AICQ client: agent storage,
 * registration, challenge-response login, and token refresh.
 */
class AuthManager {
    constructor(serverUrl = DEFAULT_SERVER, storageDir) {
        this.agents = new Map();
        this.currentAgentId = null;
        this.tokens = null;
        this.serverUrl = serverUrl;
        this.apiBase = `${serverUrl}/api/v1`;
        this.storageDir = storageDir ?? path.join(process.cwd(), ".aicq_agents");
        this.loadAgentsFromDisk();
    }
    // ─── Agent Persistence ───
    loadAgentsFromDisk() {
        try {
            if (!fs.existsSync(this.storageDir))
                return;
            const files = fs.readdirSync(this.storageDir);
            for (const file of files) {
                if (!file.endsWith(".json"))
                    continue;
                try {
                    const raw = fs.readFileSync(path.join(this.storageDir, file), "utf-8");
                    const agent = JSON.parse(raw);
                    if (agent.agentId && agent.publicKey && agent.secretKey) {
                        this.agents.set(agent.agentId, agent);
                    }
                }
                catch {
                    // skip corrupted files
                }
            }
        }
        catch {
            // storage dir may not exist yet
        }
    }
    saveAgentToDisk(agent) {
        try {
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
            }
            const filePath = path.join(this.storageDir, `${agent.agentId}.json`);
            fs.writeFileSync(filePath, JSON.stringify(agent, null, 2), "utf-8");
        }
        catch (err) {
            // Non-fatal: agent is still available in-memory
        }
    }
    // ─── Getters ───
    getCurrentAgent() {
        if (this.currentAgentId) {
            return this.agents.get(this.currentAgentId) ?? null;
        }
        return null;
    }
    setCurrentAgent(agentId) {
        if (this.agents.has(agentId)) {
            this.currentAgentId = agentId;
            return true;
        }
        return false;
    }
    getTokens() {
        return this.tokens;
    }
    setTokens(tokens) {
        this.tokens = tokens;
    }
    getAccessToken() {
        return this.tokens?.accessToken ?? null;
    }
    // ─── Registration ───
    /**
     * Register a new AI agent on the server.
     * Generates an Ed25519 keypair, posts to /auth/register/ai, and stores the agent.
     */
    async createAgent(name) {
        const [publicKey, secretKey] = (0, crypto_1.generateSigningKeypair)();
        const body = JSON.stringify({ name, publicKey });
        const res = await this.httpPost("/auth/register/ai", body);
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AuthError(`Agent registration failed: ${errText}`, res.status, "/api/v1/auth/register/ai");
        }
        const data = (await res.json());
        const agent = {
            agentId: data.agentId,
            name,
            publicKey: data.publicKey ?? publicKey,
            secretKey,
            createdAt: new Date().toISOString(),
        };
        this.agents.set(agent.agentId, agent);
        this.currentAgentId = agent.agentId;
        this.saveAgentToDisk(agent);
        return agent;
    }
    /**
     * Load a previously created agent by ID.
     * If agentId is omitted, returns the current agent.
     */
    loadAgent(agentId) {
        if (agentId) {
            return this.agents.get(agentId) ?? null;
        }
        return this.getCurrentAgent();
    }
    /**
     * List all locally stored agents.
     */
    listAgents() {
        return Array.from(this.agents.values());
    }
    /**
     * Load an existing agent identity from just the Ed25519 secret key.
     *
     * This is the primary entry point for one-shot invocation helpers
     * (see invokeAgentStream) where the caller has the agent's secret key
     * but no persisted agent record. The public key is derived locally
     * via tweetnacl; no server round-trip is made. After calling this,
     * call login() to authenticate with the server.
     *
     * @param secretKeyHex - 128-char hex Ed25519 secret key
     * @param agentIdHint - optional account ID hint (skips a later lookup)
     * @param nameHint - optional display name (cosmetic only)
     * @returns the constructed Agent, also set as current
     */
    loadFromSecretKey(secretKeyHex, agentIdHint, nameHint) {
        if (!secretKeyHex) {
            throw new errors_1.AuthError("loadFromSecretKey: secretKeyHex is empty");
        }
        const publicKey = (0, crypto_1.derivePublicKeyFromSecret)(secretKeyHex);
        const agent = {
            agentId: agentIdHint ?? publicKey,
            name: nameHint ?? "imported-agent",
            publicKey,
            secretKey: secretKeyHex,
            createdAt: new Date().toISOString(),
        };
        this.agents.set(agent.agentId, agent);
        this.currentAgentId = agent.agentId;
        this.saveAgentToDisk(agent);
        return agent;
    }
    // ─── Login (Challenge-Response) ───
    /**
     * Full challenge-response login flow.
     * 1. Request a challenge from the server.
     * 2. Sign the challenge with the agent's Ed25519 secret key.
     * 3. Submit the signed challenge to /auth/login/agent.
     * @returns access_token
     */
    async login() {
        const agent = this.getCurrentAgent();
        if (!agent) {
            throw new errors_1.AuthError("No agent set — call createAgent() or setCurrentAgent() first");
        }
        // Step 1: Get challenge
        const challengeRes = await this.httpPost("/auth/challenge", JSON.stringify({ publicKey: agent.publicKey }));
        if (!challengeRes.ok) {
            const errText = await challengeRes.text().catch(() => "Unknown error");
            throw new errors_1.AuthError(`Challenge request failed: ${errText}`, challengeRes.status, "/api/v1/auth/challenge");
        }
        const challengeData = (await challengeRes.json());
        // Step 2: Sign the challenge
        const signature = (0, crypto_1.sign)(challengeData.challenge, agent.secretKey);
        // Step 3: Login with signature
        const loginRes = await this.httpPost("/auth/login/agent", JSON.stringify({
            publicKey: agent.publicKey,
            challenge: challengeData.challenge,
            signature,
            token: challengeData.token,
        }));
        if (!loginRes.ok) {
            const errText = await loginRes.text().catch(() => "Unknown error");
            throw new errors_1.AuthError(`Login failed: ${errText}`, loginRes.status, "/api/v1/auth/login/agent");
        }
        const loginData = (await loginRes.json());
        this.tokens = {
            accessToken: loginData.accessToken,
            refreshToken: loginData.refreshToken,
            expiresIn: loginData.expiresIn,
        };
        return loginData.accessToken;
    }
    // ─── Token Refresh ───
    /**
     * Refresh the access token using the stored refresh token.
     */
    async refreshAuth() {
        if (!this.tokens?.refreshToken) {
            throw new errors_1.AuthError("No refresh token available — must login again");
        }
        const res = await this.httpPost("/auth/refresh", JSON.stringify({ refreshToken: this.tokens.refreshToken }));
        if (!res.ok) {
            const errText = await res.text().catch(() => "Unknown error");
            throw new errors_1.AuthError(`Token refresh failed: ${errText}`, res.status, "/api/v1/auth/refresh");
        }
        const data = (await res.json());
        this.tokens = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken ?? this.tokens.refreshToken,
            expiresIn: data.expiresIn,
        };
    }
    /**
     * Ensure authentication: refresh token if available, otherwise login.
     * Falls back to login on refresh failure (e.g. refresh_token expired).
     */
    async ensureAuth() {
        try {
            if (this.tokens?.refreshToken) {
                await this.refreshAuth();
            }
            else {
                await this.login();
            }
        }
        catch {
            // Refresh failed — try full login
            await this.login();
        }
    }
    // ─── HTTP Helper ───
    /**
     * Low-level POST to an API endpoint (no auth header, no auto-retry).
     * Used internally by auth flows. General requests should use the client's
     * http() method which adds Authorization and handles 401 retry.
     */
    async httpPost(endpoint, body) {
        const url = `${this.apiBase}${endpoint}`;
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        });
    }
    /**
     * Return the API base URL for use by other modules.
     */
    getApiBase() {
        return this.apiBase;
    }
    /**
     * Return the server URL.
     */
    getServerUrl() {
        return this.serverUrl;
    }
    /**
     * Clear all tokens (for logout).
     */
    clearTokens() {
        this.tokens = null;
    }
}
exports.AuthManager = AuthManager;
//# sourceMappingURL=auth.js.map