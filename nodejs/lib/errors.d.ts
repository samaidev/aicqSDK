/**
 * AICQ SDK — Error classes
 * All HTTP errors include status code, server message, and the endpoint that failed.
 */
/**
 * Base error for all AICQ SDK errors.
 */
export declare class AICQError extends Error {
    readonly statusCode?: number;
    readonly endpoint?: string;
    readonly detail?: string;
    constructor(message: string, statusCode?: number, endpoint?: string, detail?: string);
    toString(): string;
}
/**
 * Authentication failures — invalid credentials, expired tokens,
 * challenge-response failures, etc.
 */
export declare class AuthError extends AICQError {
    constructor(message: string, statusCode?: number, endpoint?: string, detail?: string);
}
/**
 * WebSocket / network failures — disconnections, timeouts,
 * reconnection exhaustion, etc.
 */
export declare class ConnectionError extends AICQError {
    constructor(message: string, statusCode?: number, endpoint?: string, detail?: string);
}
//# sourceMappingURL=errors.d.ts.map