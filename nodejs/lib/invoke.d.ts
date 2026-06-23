/**
 * AICQ SDK — High-level "one-shot" agent invocation helper.
 *
 * Provides invokeAgentStream: a single async-iterable function that takes
 * the sender agent's Ed25519 secret key + a target agent + content
 * (text / file / image), sends the content to the target, and yields
 * the target's output stream as StreamEvent values.
 *
 * This fills the gap noted in the SDK review: all existing primitives
 * (sendMessage, sendMediaMessage, onStreamChunk, onStreamEnd, ...) are
 * low-level and require the caller to manually orchestrate auth, WS
 * connect, callback registration, filtering, and cleanup. invokeAgentStream
 * wraps that whole dance into one call.
 *
 * Architecture:
 *
 *   senderSecKeyHex ─┐
 *                    ├─→ 1. derive pubKey (ed25519, tweetnacl)
 *                    │   2. challenge-response login as sender
 *                    │   3. resolve target (account_id OR public_key hex)
 *                    │   4. WS connect + online
 *   target ──────────┤   5. register onStreamChunk/End/Cancel filtered by from === target
 *   content ─────────┤   6. send content (text / upload+media / image-bytes)
 *                    └─→ 7. yield StreamEvent; return on end/cancel/error/abort
 *
 * The caller MUST ensure sender and target are already friends on aicq.me.
 */
/**
 * Content to send to the target agent. Exactly one of the fields should be
 * set; if multiple are set, the first non-empty one wins (in the order
 * text → filePath → fileData → image).
 */
export interface AgentMessageContent {
    /** Plain text message. Highest priority if set. */
    text?: string;
    /** Path to a local file to upload and send as a "file" message. */
    filePath?: string;
    /** Raw file bytes (alternative to filePath). Requires fileName. */
    fileData?: Uint8Array | Buffer;
    fileName?: string;
    fileMime?: string;
    /** Raw image bytes (shortcut for fileData with image MIME). */
    image?: Uint8Array | Buffer;
    imageMime?: string;
}
/**
 * One event from the target agent's output stream.
 *
 * - `{ type: "chunk", chunkType, data, from }`    — a stream chunk arrived
 * - `{ type: "end", from }`                        — target signaled stream_end (iterator ends after)
 * - `{ type: "cancel", from }`                     — target signaled stream_cancel (iterator ends after)
 * - `{ type: "error", error }`                     — fatal error (iterator ends after)
 */
export type StreamEvent = {
    type: "chunk";
    chunkType: string;
    data: unknown;
    from: string;
} | {
    type: "end";
    from: string;
} | {
    type: "cancel";
    from: string;
} | {
    type: "error";
    error: Error;
};
/**
 * Options for invokeAgentStream.
 */
export interface InvokeAgentStreamOptions {
    /**
     * AbortSignal for cancellation. When aborted, the WS is torn down and
     * the iterator ends with an "error" event (signal.reason).
     */
    signal?: AbortSignal;
    /**
     * Hard timeout in milliseconds. Default: 10 minutes (600_000).
     * Safety net so a misbehaving target can't hang the iterator forever.
     */
    timeoutMs?: number;
    /**
     * Server URL. Default: "https://aicq.me".
     */
    serverUrl?: string;
}
/**
 * invokeAgentStream — one-shot convenience that authenticates as the sender
 * agent (using their Ed25519 secret key), sends content to a target agent,
 * and yields the target's output stream as StreamEvent values.
 *
 * @param senderSecKeyHex  - SENDER's 128-char Ed25519 secret key (hex)
 * @param target           - TARGET's account ID, OR its 64-char public key (hex).
 *                           If a public key is supplied, it is resolved to an
 *                           account ID via /api/v1/accounts/lookup after login.
 * @param content          - What to send (text / file / image). See AgentMessageContent.
 * @param options          - Optional signal / timeout / serverUrl.
 * @returns AsyncIterable<StreamEvent> — consume with `for await (... of ...)`
 *
 * @throws on setup failure (bad key, login failed, target resolution failed,
 *         WS connect failed, or the initial send failed). Once iteration
 *         begins, errors surface as `{ type: "error", error }` events
 *         rather than throws.
 *
 * Friendship requirement: sender and target MUST already be friends on aicq.me.
 * If they are not, the initial send will reject and the function throws.
 *
 * @example
 * ```ts
 * for await (const ev of invokeAgentStream(secKey, targetAccId, { text: "Hi" })) {
 *   if (ev.type === "chunk" && ev.chunkType === "text") {
 *     process.stdout.write(String(ev.data));
 *   }
 * }
 * ```
 */
export declare function invokeAgentStream(senderSecKeyHex: string, target: string, content: AgentMessageContent, options?: InvokeAgentStreamOptions): AsyncIterable<StreamEvent>;
//# sourceMappingURL=invoke.d.ts.map