"use strict";
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
exports.invokeAgentStream = invokeAgentStream;
const client_1 = require("./client");
const crypto_1 = require("./crypto");
const errors_1 = require("./errors");
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
async function* invokeAgentStream(senderSecKeyHex, target, content, options = {}) {
    if (!senderSecKeyHex) {
        throw new errors_1.AICQError("invokeAgentStream: senderSecKeyHex is empty", 0, "(local)");
    }
    if (!target) {
        throw new errors_1.AICQError("invokeAgentStream: target is empty", 0, "(local)");
    }
    validateContent(content);
    const serverUrl = options.serverUrl ?? "https://aicq.me";
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    // 1. Build a fresh client (one-shot, no shared state).
    const client = new client_1.AICQClient(serverUrl);
    // 2. Inject the sender's secret key by deriving the public key locally.
    //    The auth manager stores it as the current agent.
    //    NOTE: we cast to `any` because loadFromSecretKey is on AuthManager
    //    (a private field of AICQClient). We expose the method via a tiny
    //    accessor below to avoid breaking encapsulation in the public API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authAny = client.auth;
    if (!authAny || typeof authAny.loadFromSecretKey !== "function") {
        throw new errors_1.AICQError("invokeAgentStream: AICQClient.auth.loadFromSecretKey is not available — " +
            "requires SDK >= 1.1 with loadFromSecretKey support", 0, "(local)");
    }
    let senderPubKey;
    try {
        senderPubKey = (0, crypto_1.derivePublicKeyFromSecret)(senderSecKeyHex);
        authAny.loadFromSecretKey(senderSecKeyHex, senderPubKey, "invoke-sender");
    }
    catch (e) {
        throw new errors_1.AICQError(`invokeAgentStream: bad sender secret key: ${e.message}`, 0, "(local)");
    }
    // 3. Challenge-response login as the sender.
    try {
        await client.login();
    }
    catch (e) {
        client.close();
        throw new errors_1.AICQError(`invokeAgentStream: sender login failed: ${e.message}`, 0, "/api/v1/auth/login/agent");
    }
    // 4. Resolve target. If `target` looks like a 64-char hex pubkey,
    //    look it up; otherwise treat it as an account_id.
    let targetAccountId = target;
    if (/^[0-9a-fA-F]{64}$/.test(target)) {
        try {
            const acct = await client.lookupAccount(target);
            // AccountInfo.id is the canonical account_id returned by the server.
            targetAccountId = acct.id ?? target;
        }
        catch (e) {
            client.close();
            throw new errors_1.AICQError(`invokeAgentStream: resolve target public key failed: ${e.message}`, 0, "/api/v1/accounts/lookup");
        }
    }
    // 5. Connect WS.
    try {
        client.connect();
    }
    catch (e) {
        client.close();
        throw new errors_1.AICQError(`invokeAgentStream: WS connect failed: ${e.message}`, 0, "(websocket)");
    }
    // Give the WS a brief moment to actually open. The SDK's connect() returns
    // immediately without awaiting the open handshake, so we wait for the
    // 'connected' state with a small timeout.
    await waitForConnected(client, 5000);
    // 6. Set up the event queue + filtered callbacks.
    //    We use a promise-driven queue so the async generator can pull events
    //    on demand while callbacks push them in real-time.
    const queue = [];
    let resolveNext = null;
    let isDone = false;
    const enqueue = (ev) => {
        if (isDone)
            return;
        queue.push(ev);
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ done: false, value: queue.shift() });
        }
    };
    const finish = () => {
        if (isDone)
            return;
        isDone = true;
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ done: true });
        }
    };
    // Filter: only forward events whose `from` matches our target.
    const isFromTarget = (fromId) => !!fromId && fromId === targetAccountId;
    client.onStreamChunk((msg) => {
        if (!isFromTarget(msg.from))
            return;
        enqueue({
            type: "chunk",
            chunkType: msg.chunkType,
            data: msg.data,
            from: msg.from,
        });
    });
    client.onStreamEnd((msg) => {
        if (!isFromTarget(msg.from))
            return;
        enqueue({ type: "end", from: msg.from });
        // Slight delay to let the consumer see the "end" event before we tear down.
        setTimeout(finish, 0);
    });
    client.onStreamCancel((msg) => {
        if (!isFromTarget(msg.from))
            return;
        enqueue({ type: "cancel", from: msg.from });
        setTimeout(finish, 0);
    });
    // 7. Set up cancellation + timeout.
    const abortController = new AbortController();
    const externalSignal = options.signal;
    const onExternalAbort = () => {
        if (isDone)
            return;
        enqueue({ type: "error", error: externalSignal?.reason ?? new Error("aborted") });
        abortController.abort();
        setTimeout(finish, 0);
    };
    if (externalSignal) {
        if (externalSignal.aborted) {
            onExternalAbort();
        }
        else {
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    const timeoutId = setTimeout(() => {
        if (isDone)
            return;
        enqueue({
            type: "error",
            error: new Error(`invokeAgentStream: hard timeout (${timeoutMs}ms)`),
        });
        abortController.abort();
        setTimeout(finish, 0);
    }, timeoutMs);
    // 8. Send the content. Failure here throws out of the function (before
    //    iteration begins), matching the Go behavior.
    try {
        await sendContent(client, targetAccountId, content);
    }
    catch (e) {
        clearTimeout(timeoutId);
        client.disconnect();
        client.close();
        throw new errors_1.AICQError(`invokeAgentStream: send content failed: ${e.message}`, 0, "/api/v1/chat/messages");
    }
    // 9. Yield events until done.
    try {
        while (!isDone) {
            // If queue has events, drain immediately; otherwise wait for callback.
            if (queue.length > 0) {
                yield queue.shift();
                continue;
            }
            // Wait for the next event (or finish()).
            const next = await new Promise((resolve) => {
                resolveNext = resolve;
            });
            if (next.done)
                break;
            if (next.value)
                yield next.value;
        }
    }
    finally {
        clearTimeout(timeoutId);
        if (externalSignal) {
            externalSignal.removeEventListener("abort", onExternalAbort);
        }
        client.disconnect();
        client.close();
    }
}
// ─── Helpers ──────────────────────────────────────────────────────
function validateContent(c) {
    const count = [
        c.text ? 1 : 0,
        c.filePath ? 1 : 0,
        c.fileData && c.fileData.length > 0 ? 1 : 0,
        c.image && c.image.length > 0 ? 1 : 0,
    ].reduce((a, b) => a + b, 0);
    if (count === 0) {
        throw new errors_1.AICQError("invokeAgentStream: content is empty — set one of text/filePath/fileData/image", 0, "(local)");
    }
    if (count > 1) {
        throw new errors_1.AICQError(`invokeAgentStream: content is ambiguous — set exactly one of text/filePath/fileData/image (got ${count})`, 0, "(local)");
    }
    if (c.fileData && c.fileData.length > 0 && !c.fileName) {
        throw new errors_1.AICQError("invokeAgentStream: fileData requires fileName", 0, "(local)");
    }
}
async function waitForConnected(client, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (client.isConnected())
            return;
        await new Promise((r) => setTimeout(r, 50));
    }
    // Don't throw — WS may still be connecting; the first send will fail clearly
    // if the WS isn't actually open. We just gave it a head start.
}
async function sendContent(client, targetAccountId, content) {
    // Case 1: text
    if (content.text) {
        await client.sendMessage(targetAccountId, content.text);
        return;
    }
    // Case 2: file path
    if (content.filePath) {
        const url = await client.uploadFile(content.filePath);
        const fileName = content.filePath.split(/[/\\]/).pop() ?? content.filePath;
        const fileInfo = {
            name: fileName,
            size: 0,
            mimeType: content.fileMime ?? "application/octet-stream",
        };
        await client.sendMediaMessage(targetAccountId, "file", url, fileInfo);
        return;
    }
    // Case 3: image bytes (shortcut)
    if (content.image && content.image.length > 0) {
        const mime = content.imageMime ?? "image/png";
        let ext = ".png";
        if (mime.includes("jpeg") || mime.includes("jpg"))
            ext = ".jpg";
        else if (mime.includes("gif"))
            ext = ".gif";
        else if (mime.includes("webp"))
            ext = ".webp";
        const fileName = content.fileName ?? `image_${Date.now()}${ext}`;
        const url = await uploadBytes(client, fileName, content.image, mime);
        const fileInfo = {
            name: fileName,
            size: content.image.length,
            mimeType: mime,
        };
        await client.sendMediaMessage(targetAccountId, "image", url, fileInfo);
        return;
    }
    // Case 4: raw file bytes
    if (content.fileData && content.fileData.length > 0) {
        const mime = content.fileMime ?? "application/octet-stream";
        const fileName = content.fileName ?? `file_${Date.now()}`;
        const url = await uploadBytes(client, fileName, content.fileData, mime);
        const fileInfo = {
            name: fileName,
            size: content.fileData.length,
            mimeType: mime,
        };
        await client.sendMediaMessage(targetAccountId, "file", url, fileInfo);
        return;
    }
}
/**
 * Upload raw bytes by writing to a temp file and calling client.uploadFile.
 * The SDK's uploadFile only accepts a file path; this helper bridges that
 * gap without requiring the caller to manage temp files.
 */
async function uploadBytes(client, fileName, data, mime) {
    const fs = await Promise.resolve().then(() => __importStar(require("fs")));
    const path = await Promise.resolve().then(() => __importStar(require("path")));
    const os = await Promise.resolve().then(() => __importStar(require("os")));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicq-invoke-"));
    const tmpPath = path.join(tmpDir, fileName);
    try {
        fs.writeFileSync(tmpPath, data);
        return await client.uploadFile(tmpPath, fileName);
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
}
//# sourceMappingURL=invoke.js.map