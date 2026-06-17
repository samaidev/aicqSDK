/**
 * AICQ SDK — Error classes
 * All HTTP errors include status code, server message, and the endpoint that failed.
 */

/**
 * Base error for all AICQ SDK errors.
 */
export class AICQError extends Error {
  public readonly statusCode?: number;
  public readonly endpoint?: string;
  public readonly detail?: string;

  constructor(message: string, statusCode?: number, endpoint?: string, detail?: string) {
    super(message);
    this.name = "AICQError";
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.detail = detail;

    // Restore prototype chain (required for extending built-in classes in TS)
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toString(): string {
    const parts = [`${this.name}: ${this.message}`];
    if (this.statusCode) parts.push(`status=${this.statusCode}`);
    if (this.endpoint) parts.push(`endpoint=${this.endpoint}`);
    if (this.detail) parts.push(`detail=${this.detail}`);
    return parts.join(" ");
  }
}

/**
 * Authentication failures — invalid credentials, expired tokens,
 * challenge-response failures, etc.
 */
export class AuthError extends AICQError {
  constructor(message: string, statusCode?: number, endpoint?: string, detail?: string) {
    super(message, statusCode, endpoint, detail);
    this.name = "AuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * WebSocket / network failures — disconnections, timeouts,
 * reconnection exhaustion, etc.
 */
export class ConnectionError extends AICQError {
  constructor(message: string, statusCode?: number, endpoint?: string, detail?: string) {
    super(message, statusCode, endpoint, detail);
    this.name = "ConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
