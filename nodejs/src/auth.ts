/**
 * AICQ SDK — Authentication module
 * Handles AI agent registration, challenge-response login, and token refresh.
 */

import type {
  Agent,
  RegisterAIResponse,
  ChallengeResponse,
  LoginAgentResponse,
  RefreshResponse,
  AuthTokens,
} from "./types";
import { AuthError, AICQError } from "./errors";
import { generateSigningKeypair, sign } from "./crypto";
import * as fs from "fs";
import * as path from "path";

/** Default base URL for the AICQ REST API. */
const DEFAULT_SERVER = "https://aicq.me";

/**
 * Manages authentication for an AICQ client: agent storage,
 * registration, challenge-response login, and token refresh.
 */
export class AuthManager {
  private serverUrl: string;
  private apiBase: string;
  private storageDir: string;
  private agents: Map<string, Agent> = new Map();
  private currentAgentId: string | null = null;
  private tokens: AuthTokens | null = null;

  constructor(serverUrl: string = DEFAULT_SERVER, storageDir?: string) {
    this.serverUrl = serverUrl;
    this.apiBase = `${serverUrl}/api/v1`;
    this.storageDir = storageDir ?? path.join(process.cwd(), ".aicq_agents");
    this.loadAgentsFromDisk();
  }

  // ─── Agent Persistence ───

  private loadAgentsFromDisk(): void {
    try {
      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.storageDir, file), "utf-8");
          const agent: Agent = JSON.parse(raw);
          if (agent.agentId && agent.publicKey && agent.secretKey) {
            this.agents.set(agent.agentId, agent);
          }
        } catch {
          // skip corrupted files
        }
      }
    } catch {
      // storage dir may not exist yet
    }
  }

  private saveAgentToDisk(agent: Agent): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      const filePath = path.join(this.storageDir, `${agent.agentId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(agent, null, 2), "utf-8");
    } catch (err) {
      // Non-fatal: agent is still available in-memory
    }
  }

  // ─── Getters ───

  getCurrentAgent(): Agent | null {
    if (this.currentAgentId) {
      return this.agents.get(this.currentAgentId) ?? null;
    }
    return null;
  }

  setCurrentAgent(agentId: string): boolean {
    if (this.agents.has(agentId)) {
      this.currentAgentId = agentId;
      return true;
    }
    return false;
  }

  getTokens(): AuthTokens | null {
    return this.tokens;
  }

  setTokens(tokens: AuthTokens): void {
    this.tokens = tokens;
  }

  getAccessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  // ─── Registration ───

  /**
   * Register a new AI agent on the server.
   * Generates an Ed25519 keypair, posts to /auth/register/ai, and stores the agent.
   */
  async createAgent(name: string): Promise<Agent> {
    const [publicKey, secretKey] = generateSigningKeypair();

    const body = JSON.stringify({ name, publicKey });
    const res = await this.httpPost("/auth/register/ai", body);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AuthError(
        `Agent registration failed: ${errText}`,
        res.status,
        "/api/v1/auth/register/ai",
      );
    }

    const data = (await res.json()) as RegisterAIResponse;
    const agent: Agent = {
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
  loadAgent(agentId?: string): Agent | null {
    if (agentId) {
      return this.agents.get(agentId) ?? null;
    }
    return this.getCurrentAgent();
  }

  /**
   * List all locally stored agents.
   */
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  // ─── Login (Challenge-Response) ───

  /**
   * Full challenge-response login flow.
   * 1. Request a challenge from the server.
   * 2. Sign the challenge with the agent's Ed25519 secret key.
   * 3. Submit the signed challenge to /auth/login/agent.
   * @returns access_token
   */
  async login(): Promise<string> {
    const agent = this.getCurrentAgent();
    if (!agent) {
      throw new AuthError("No agent set — call createAgent() or setCurrentAgent() first");
    }

    // Step 1: Get challenge
    const challengeRes = await this.httpPost(
      "/auth/challenge",
      JSON.stringify({ publicKey: agent.publicKey }),
    );

    if (!challengeRes.ok) {
      const errText = await challengeRes.text().catch(() => "Unknown error");
      throw new AuthError(
        `Challenge request failed: ${errText}`,
        challengeRes.status,
        "/api/v1/auth/challenge",
      );
    }

    const challengeData = (await challengeRes.json()) as ChallengeResponse;

    // Step 2: Sign the challenge
    const signature = sign(challengeData.challenge, agent.secretKey);

    // Step 3: Login with signature
    const loginRes = await this.httpPost(
      "/auth/login/agent",
      JSON.stringify({
        publicKey: agent.publicKey,
        challenge: challengeData.challenge,
        signature,
        token: challengeData.token,
      }),
    );

    if (!loginRes.ok) {
      const errText = await loginRes.text().catch(() => "Unknown error");
      throw new AuthError(
        `Login failed: ${errText}`,
        loginRes.status,
        "/api/v1/auth/login/agent",
      );
    }

    const loginData = (await loginRes.json()) as LoginAgentResponse;
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
  async refreshAuth(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new AuthError("No refresh token available — must login again");
    }

    const res = await this.httpPost(
      "/auth/refresh",
      JSON.stringify({ refreshToken: this.tokens.refreshToken }),
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new AuthError(
        `Token refresh failed: ${errText}`,
        res.status,
        "/api/v1/auth/refresh",
      );
    }

    const data = (await res.json()) as RefreshResponse;
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
  async ensureAuth(): Promise<void> {
    try {
      if (this.tokens?.refreshToken) {
        await this.refreshAuth();
      } else {
        await this.login();
      }
    } catch {
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
  private async httpPost(endpoint: string, body: string): Promise<Response> {
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
  getApiBase(): string {
    return this.apiBase;
  }

  /**
   * Return the server URL.
   */
  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Clear all tokens (for logout).
   */
  clearTokens(): void {
    this.tokens = null;
  }
}
