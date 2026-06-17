"use strict";
/**
 * AICQ SDK — Error classes
 * All HTTP errors include status code, server message, and the endpoint that failed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionError = exports.AuthError = exports.AICQError = void 0;
/**
 * Base error for all AICQ SDK errors.
 */
class AICQError extends Error {
    constructor(message, statusCode, endpoint, detail) {
        super(message);
        this.name = "AICQError";
        this.statusCode = statusCode;
        this.endpoint = endpoint;
        this.detail = detail;
        // Restore prototype chain (required for extending built-in classes in TS)
        Object.setPrototypeOf(this, new.target.prototype);
    }
    toString() {
        const parts = [`${this.name}: ${this.message}`];
        if (this.statusCode)
            parts.push(`status=${this.statusCode}`);
        if (this.endpoint)
            parts.push(`endpoint=${this.endpoint}`);
        if (this.detail)
            parts.push(`detail=${this.detail}`);
        return parts.join(" ");
    }
}
exports.AICQError = AICQError;
/**
 * Authentication failures — invalid credentials, expired tokens,
 * challenge-response failures, etc.
 */
class AuthError extends AICQError {
    constructor(message, statusCode, endpoint, detail) {
        super(message, statusCode, endpoint, detail);
        this.name = "AuthError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.AuthError = AuthError;
/**
 * WebSocket / network failures — disconnections, timeouts,
 * reconnection exhaustion, etc.
 */
class ConnectionError extends AICQError {
    constructor(message, statusCode, endpoint, detail) {
        super(message, statusCode, endpoint, detail);
        this.name = "ConnectionError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.ConnectionError = ConnectionError;
//# sourceMappingURL=errors.js.map