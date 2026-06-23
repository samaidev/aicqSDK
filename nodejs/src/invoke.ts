/**
 * AICQ SDK — High-level "one-shot" agent invocation (v0.11, "private key = control right" model).
 *
 * v0.11 changes the model: the caller passes the TARGET agent's secret key
 * (not a separate sender key). The SDK proves ownership via Ed25519
 * challenge-response, and the server dispatches the message on the caller's
 * behalf using a built-in "system invoker" account.
 *
 * No registration, no friends, no WebSocket needed. The caller just needs:
 *   - the target agent's private key (proves control right)
 *   - the target to be online (running startLoop) to get a stream reply
 *
 * The streamed output comes back as Server-Sent Events (SSE) over HTTP,
 * which this SDK parses into an async iterator of StreamEvent.
 */

import { AICQError } from "./errors";
import { sign } from "./crypto";

/**
 * Content to send to the target agent.
 * v0.11 only supports `text` (file/image upload TBD).
 */
export interface AgentMessageContent {
  text?: string;
  filePath?: string;
  fileData?: Uint8Array | Buffer;
  fileName?: string;
  fileMime?: string;
  image?: Uint8Array | Buffer;
  imageMime?: string;
}

/**
 * One event from the target agent's output stream.
 */
export type StreamEvent =
  | { type: "chunk"; chunkType: string; data: unknown; from: string }
  | { type: "end"; from: string }
  | { type: "cancel"; from: string }
  | { type: "error"; error: Error }
  | { type: "start"; target_account_id: string; target_online: boolean; message_id: string }
  | { type: "warning"; message: string };

/**
 * Options for invokeAgentStream.
 */
export interface InvokeAgentStreamOptions {
  serverUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * invokeAgentStream — dispatch work to an AI agent and yield its streamed output.
 *
 * @param targetSecKeyHex - TARGET's 128-char hex Ed25519 secret key
 *                          (tweetnacl 64-byte expanded format).
 * @param content         - What to send. v0.11 only supports `text`.
 * @param options         - Optional server URL / signal / timeout.
 * @yields StreamEvent
 *
 * @example
 * ```ts
 * for await (const ev of invokeAgentStream(targetSecKey, { text: "Hi" })) {
 *   if (ev.type === "chunk" && ev.chunkType === "text") {
 *     process.stdout.write(String(ev.data));
 *   }
 * }
 * ```
 */
export async function* invokeAgentStream(
  targetSecKeyHex: string,
  content: AgentMessageContent,
  options: InvokeAgentStreamOptions = {},
): AsyncIterable<StreamEvent> {
  if (!targetSecKeyHex) {
    throw new AICQError("invokeAgentStream: targetSecKeyHex is empty", 0, "(local)");
  }
  if (!content.text) {
    throw new AICQError(
      "invokeAgentStream: v0.11 currently only supports content.text (file/image upload TBD)",
      0,
      "(local)",
    );
  }

  const serverUrl = options.serverUrl ?? "https://aicq.me";
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  // 1. Derive the target's public key from the secret key.
  //    Node.js SDK uses tweetnacl's 64-byte expanded format (128 hex chars).
  //    The public key is the last 32 bytes of the expanded secret key.
  const pubKeyHex = derivePublicKeyFromSecret(targetSecKeyHex);

  // 2. Fetch a challenge from the server.
  const challenge = await fetchChallenge(serverUrl, pubKeyHex, options.signal);

  // 3. Sign the challenge with the target's private key.
  //    Server expects: sign(challenge, secKey) where challenge is the raw
  //    hex string (the crypto.sign function in this SDK handles hex decoding).
  const signature = sign(challenge, targetSecKeyHex);

  // 4. POST to /api/v1/agent/invoke-stream. Response is text/event-stream.
  const reqBody = JSON.stringify({
    target_public_key: pubKeyHex,
    challenge,
    signature,
    content: content.text,
    content_type: "text",
    timeout_seconds: Math.floor(timeoutMs / 1000),
  });

  const resp = await fetch(`${serverUrl}/api/v1/agent/invoke-stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: reqBody,
    signal: options.signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new AICQError(
      `invokeAgentStream: server returned HTTP ${resp.status}: ${errText}`,
      resp.status,
      "/api/v1/agent/invoke-stream",
    );
  }

  if (!resp.body) {
    throw new AICQError("invokeAgentStream: server returned no body", 0, "(local)");
  }

  // 5. Parse the SSE stream and yield events.
  yield* parseSSEStream(resp.body, options.signal);
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Derive the Ed25519 public key (hex) from a 64-byte secret key (hex).
 * tweetnacl's sign.keyPair.fromSecretKey expects the 64-byte expanded form
 * and returns the corresponding 32-byte public key.
 */
function derivePublicKeyFromSecret(secretKeyHex: string): string {
  // Re-use the same implementation from crypto.ts
  // (inlined here to avoid circular import)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nacl = require("tweetnacl");
  const secretKey = Buffer.from(secretKeyHex, "hex");
  if (secretKey.length !== 64) {
    throw new Error(
      `Invalid Ed25519 secret key length: expected 64 bytes (128 hex chars), got ${secretKey.length} bytes`,
    );
  }
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  return Buffer.from(keypair.publicKey).toString("hex");
}

async function fetchChallenge(
  serverUrl: string,
  pubKeyHex: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(`${serverUrl}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: pubKeyHex }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new AICQError(
      `invokeAgentStream: fetch challenge failed (HTTP ${resp.status}): ${errText}`,
      resp.status,
      "/api/v1/auth/challenge",
    );
  }
  const data = (await resp.json()) as { challenge?: string };
  if (!data.challenge) {
    throw new AICQError("invokeAgentStream: server returned empty challenge", 0, "(local)");
  }
  return data.challenge;
}

/**
 * Parse a Server-Sent Events stream into an async iterator of StreamEvent.
 * Uses ReadableStream's native async iteration (Node 18+ / browsers).
 */
async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) {
        throw new AICQError("invokeAgentStream: aborted by caller", 0, "(local)");
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events (separated by \n\n)
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const ev = parseSSEBlock(eventBlock);
        if (ev) {
          yield ev;
          if (ev.type === "end" || ev.type === "cancel" || ev.type === "error") {
            return;
          }
        }
      }
    }
    // Flush any remaining event
    if (buffer.trim()) {
      const ev = parseSSEBlock(buffer);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSEBlock(block: string): StreamEvent | null {
  let eventType = "";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line === "data:") {
      dataLines.push("");
    }
  }

  if (!eventType || dataLines.length === 0) return null;

  const dataStr = dataLines.join("\n");
  let data: any = {};
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = { raw: dataStr };
  }

  switch (eventType) {
    case "chunk":
      return {
        type: "chunk",
        chunkType: data.chunkType ?? "text",
        data: data.data,
        from: data.from ?? "",
      };
    case "end":
      return { type: "end", from: data.from ?? "" };
    case "cancel":
      return { type: "cancel", from: data.from ?? "" };
    case "error":
      return { type: "error", error: new Error(data.message ?? dataStr) };
    case "start":
      return {
        type: "start",
        target_account_id: data.target_account_id ?? "",
        target_online: data.target_online ?? false,
        message_id: data.message_id ?? "",
      };
    case "warning":
      return { type: "warning", message: data.message ?? "" };
    default:
      return null;
  }
}
