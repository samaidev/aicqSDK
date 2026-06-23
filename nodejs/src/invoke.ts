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

import { AICQClient } from "./client";
import { derivePublicKeyFromSecret } from "./crypto";
import { AICQError } from "./errors";
import type {
  StreamChunkMessage,
  StreamEndMessage,
  StreamCancelMessage,
} from "./types";

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
export type StreamEvent =
  | { type: "chunk"; chunkType: string; data: unknown; from: string }
  | { type: "end"; from: string }
  | { type: "cancel"; from: string }
  | { type: "error"; error: Error };

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
export async function* invokeAgentStream(
  senderSecKeyHex: string,
  target: string,
  content: AgentMessageContent,
  options: InvokeAgentStreamOptions = {},
): AsyncIterable<StreamEvent> {
  if (!senderSecKeyHex) {
    throw new AICQError("invokeAgentStream: senderSecKeyHex is empty", 0, "(local)");
  }
  if (!target) {
    throw new AICQError("invokeAgentStream: target is empty", 0, "(local)");
  }
  validateContent(content);

  const serverUrl = options.serverUrl ?? "https://aicq.me";
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  // 1. Build a fresh client (one-shot, no shared state).
  const client = new AICQClient(serverUrl);

  // 2. Inject the sender's secret key by deriving the public key locally.
  //    The auth manager stores it as the current agent.
  //    NOTE: we cast to `any` because loadFromSecretKey is on AuthManager
  //    (a private field of AICQClient). We expose the method via a tiny
  //    accessor below to avoid breaking encapsulation in the public API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authAny = (client as any).auth;
  if (!authAny || typeof authAny.loadFromSecretKey !== "function") {
    throw new AICQError(
      "invokeAgentStream: AICQClient.auth.loadFromSecretKey is not available — " +
        "requires SDK >= 1.1 with loadFromSecretKey support",
      0,
      "(local)",
    );
  }
  let senderPubKey: string;
  try {
    senderPubKey = derivePublicKeyFromSecret(senderSecKeyHex);
    authAny.loadFromSecretKey(senderSecKeyHex, senderPubKey, "invoke-sender");
  } catch (e) {
    throw new AICQError(
      `invokeAgentStream: bad sender secret key: ${(e as Error).message}`,
      0,
      "(local)",
    );
  }

  // 3. Challenge-response login as the sender.
  try {
    await client.login();
  } catch (e) {
    client.close();
    throw new AICQError(
      `invokeAgentStream: sender login failed: ${(e as Error).message}`,
      0,
      "/api/v1/auth/login/agent",
    );
  }

  // 4. Resolve target. If `target` looks like a 64-char hex pubkey,
  //    look it up; otherwise treat it as an account_id.
  let targetAccountId = target;
  if (/^[0-9a-fA-F]{64}$/.test(target)) {
    try {
      const acct = await client.lookupAccount(target);
      // AccountInfo.id is the canonical account_id returned by the server.
      targetAccountId = acct.id ?? target;
    } catch (e) {
      client.close();
      throw new AICQError(
        `invokeAgentStream: resolve target public key failed: ${(e as Error).message}`,
        0,
        "/api/v1/accounts/lookup",
      );
    }
  }

  // 5. Connect WS.
  try {
    client.connect();
  } catch (e) {
    client.close();
    throw new AICQError(
      `invokeAgentStream: WS connect failed: ${(e as Error).message}`,
      0,
      "(websocket)",
    );
  }
  // Give the WS a brief moment to actually open. The SDK's connect() returns
  // immediately without awaiting the open handshake, so we wait for the
  // 'connected' state with a small timeout.
  await waitForConnected(client, 5000);

  // 6. Set up the event queue + filtered callbacks.
  //    We use a promise-driven queue so the async generator can pull events
  //    on demand while callbacks push them in real-time.
  const queue: StreamEvent[] = [];
  let resolveNext: ((v: { done: boolean; value?: StreamEvent }) => void) | null = null;
  let isDone = false;

  const enqueue = (ev: StreamEvent): void => {
    if (isDone) return;
    queue.push(ev);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ done: false, value: queue.shift() });
    }
  };

  const finish = (): void => {
    if (isDone) return;
    isDone = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ done: true });
    }
  };

  // Filter: only forward events whose `from` matches our target.
  const isFromTarget = (fromId: string | undefined): boolean =>
    !!fromId && fromId === targetAccountId;

  client.onStreamChunk((msg: StreamChunkMessage) => {
    if (!isFromTarget(msg.from)) return;
    enqueue({
      type: "chunk",
      chunkType: msg.chunkType,
      data: msg.data,
      from: msg.from,
    });
  });

  client.onStreamEnd((msg: StreamEndMessage) => {
    if (!isFromTarget(msg.from)) return;
    enqueue({ type: "end", from: msg.from });
    // Slight delay to let the consumer see the "end" event before we tear down.
    setTimeout(finish, 0);
  });

  client.onStreamCancel((msg: StreamCancelMessage) => {
    if (!isFromTarget(msg.from)) return;
    enqueue({ type: "cancel", from: msg.from });
    setTimeout(finish, 0);
  });

  // 7. Set up cancellation + timeout.
  const abortController = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = (): void => {
    if (isDone) return;
    enqueue({ type: "error", error: externalSignal?.reason ?? new Error("aborted") });
    abortController.abort();
    setTimeout(finish, 0);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    if (isDone) return;
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
  } catch (e) {
    clearTimeout(timeoutId);
    client.disconnect();
    client.close();
    throw new AICQError(
      `invokeAgentStream: send content failed: ${(e as Error).message}`,
      0,
      "/api/v1/chat/messages",
    );
  }

  // 9. Yield events until done.
  try {
    while (!isDone) {
      // If queue has events, drain immediately; otherwise wait for callback.
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      // Wait for the next event (or finish()).
      const next = await new Promise<{ done: boolean; value?: StreamEvent }>(
        (resolve) => {
          resolveNext = resolve;
        },
      );
      if (next.done) break;
      if (next.value) yield next.value;
    }
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    client.disconnect();
    client.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function validateContent(c: AgentMessageContent): void {
  const count = [
    c.text ? 1 : 0,
    c.filePath ? 1 : 0,
    c.fileData && c.fileData.length > 0 ? 1 : 0,
    c.image && c.image.length > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
  if (count === 0) {
    throw new AICQError(
      "invokeAgentStream: content is empty — set one of text/filePath/fileData/image",
      0,
      "(local)",
    );
  }
  if (count > 1) {
    throw new AICQError(
      `invokeAgentStream: content is ambiguous — set exactly one of text/filePath/fileData/image (got ${count})`,
      0,
      "(local)",
    );
  }
  if (c.fileData && c.fileData.length > 0 && !c.fileName) {
    throw new AICQError(
      "invokeAgentStream: fileData requires fileName",
      0,
      "(local)",
    );
  }
}

async function waitForConnected(client: AICQClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.isConnected()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Don't throw — WS may still be connecting; the first send will fail clearly
  // if the WS isn't actually open. We just gave it a head start.
}

async function sendContent(
  client: AICQClient,
  targetAccountId: string,
  content: AgentMessageContent,
): Promise<void> {
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
    if (mime.includes("jpeg") || mime.includes("jpg")) ext = ".jpg";
    else if (mime.includes("gif")) ext = ".gif";
    else if (mime.includes("webp")) ext = ".webp";
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
async function uploadBytes(
  client: AICQClient,
  fileName: string,
  data: Uint8Array | Buffer,
  mime: string,
): Promise<string> {
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicq-invoke-"));
  const tmpPath = path.join(tmpDir, fileName);
  try {
    fs.writeFileSync(tmpPath, data);
    return await client.uploadFile(tmpPath, fileName);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
