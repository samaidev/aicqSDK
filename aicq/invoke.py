"""
aicq.invoke — High-level "one-shot" agent invocation (v0.11, "private key = control right" model).

v0.11 changes the model: the caller passes the TARGET agent's secret key
(not a separate sender key). The SDK proves ownership via Ed25519
challenge-response, and the server dispatches the message on the caller's
behalf using a built-in "system invoker" account.

No registration, no friends, no WebSocket needed. The caller just needs:
  - the target agent's private key (proves control right)
  - the target to be online (running startLoop) to get a stream reply

The streamed output comes back as Server-Sent Events (SSE) over HTTP,
which this SDK parses into an async generator of StreamEvent.

Example::

    import asyncio
    from aicq import invoke_agent_stream, AgentMessageContent

    async def main():
        async for ev in invoke_agent_stream(
            target_sec_key_hex,            # 64-char hex (pynacl 32-byte format)
            AgentMessageContent(text="Clean up /tmp logs"),
        ):
            if ev.type == "chunk" and ev.chunk_type == "text":
                print(ev.data, end="", flush=True)

    asyncio.run(main())
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

import aiohttp

from .core import AICQError
from . import crypto

logger = logging.getLogger("aicq.invoke")

DEFAULT_SERVER = "https://aicq.me"
DEFAULT_TIMEOUT_SECONDS = 600.0  # 10 minutes


@dataclass
class AgentMessageContent:
    """What to send to the target agent.

    v0.11 only supports ``text`` (file/image upload TBD).
    """

    text: Optional[str] = None
    """Plain text message — the only content type supported in v0.11."""


@dataclass
class StreamEvent:
    """One event from the target agent's output stream.

    - ``type="start"``:    stream opened, target account info delivered.
    - ``type="warning"``:  target is offline or other non-fatal warning.
    - ``type="chunk"``:    a stream chunk arrived.
    - ``type="end"``:      target signaled stream_end.
    - ``type="cancel"``:   target signaled stream_cancel.
    - ``type="error"``:    fatal error (``error`` is set).
    """

    type: str
    chunk_type: str = ""
    data: Any = None
    from_id: str = ""
    error: Optional[Exception] = None
    target_account_id: str = ""
    target_online: bool = False
    message_id: str = ""
    message: str = ""  # for warning/error events


@dataclass
class InvokeAgentStreamOptions:
    """Options for :func:`invoke_agent_stream`."""

    server_url: str = DEFAULT_SERVER
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


async def invoke_agent_stream(
    target_sec_key_hex: str,
    content: AgentMessageContent,
    options: Optional[InvokeAgentStreamOptions] = None,
) -> AsyncIterator[StreamEvent]:
    """Dispatch work to an AI agent and yield its streamed output.

    v0.11 semantics: "private key = control right". The caller passes the
    TARGET agent's secret key. The SDK proves ownership via Ed25519
    challenge-response, and the server dispatches the message on the
    caller's behalf. No registration, no friends, no WebSocket.

    Parameters:
        target_sec_key_hex: TARGET's 64-char hex Ed25519 secret key
            (pynacl 32-byte format, NOT tweetnacl's 64-byte expanded form).
        content: What to send. v0.11 only supports ``text``.
        options: Optional server URL / timeout.

    Yields:
        :class:`StreamEvent`

    Raises:
        :class:`AICQError`: on setup failure (bad key, challenge fetch
            failed, signature failed, HTTP request failed).
    """
    if not target_sec_key_hex:
        raise AICQError("invoke_agent_stream: target_sec_key_hex is empty")
    if not content.text:
        raise AICQError(
            "invoke_agent_stream: v0.11 currently only supports content.text "
            "(file/image upload TBD)"
        )

    opts = options or InvokeAgentStreamOptions()

    # 1. Derive the target's public key from the secret key.
    pub_key_hex = _derive_public_key(target_sec_key_hex)

    # 2. Fetch a challenge from the server.
    challenge = await _fetch_challenge(opts.server_url, pub_key_hex)

    # 3. Sign the challenge with the target's private key.
    #    crypto.sign() handles hex decoding of the challenge internally.
    signature = crypto.sign(challenge, target_sec_key_hex)

    # 4. POST to /api/v1/agent/invoke-stream. Response is text/event-stream.
    req_body = {
        "target_public_key": pub_key_hex,
        "challenge": challenge,
        "signature": signature,
        "content": content.text,
        "content_type": "text",
        "timeout_seconds": int(opts.timeout_seconds),
    }

    timeout = aiohttp.ClientTimeout(total=None)  # no overall timeout; SSE is long-lived
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            f"{opts.server_url}/api/v1/agent/invoke-stream",
            json=req_body,
            headers={"Accept": "text/event-stream"},
        ) as resp:
            if resp.status != 200:
                err_text = await resp.text()
                raise AICQError(
                    f"invoke_agent_stream: server returned HTTP {resp.status}: {err_text}"
                )

            # 5. Parse the SSE stream and yield events.
            async for ev in _parse_sse_stream(resp):
                yield ev
                if ev.type in ("end", "cancel", "error"):
                    return


# ─── Helpers ───────────────────────────────────────────────────────


def _derive_public_key(secret_key_hex: str) -> str:
    """Derive the Ed25519 public key (hex) from a pynacl secret key (hex).

    pynacl's SigningKey is 32 bytes (64 hex chars).
    """
    from nacl.signing import SigningKey
    from nacl.encoding import HexEncoder

    sk = SigningKey(secret_key_hex, encoder=HexEncoder)
    return sk.verify_key.encode(encoder=HexEncoder).decode()


async def _fetch_challenge(server_url: str, pub_key_hex: str) -> str:
    """Call POST /api/v1/auth/challenge and return the challenge hex string."""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{server_url}/api/v1/auth/challenge",
            json={"public_key": pub_key_hex},
        ) as resp:
            if resp.status != 200:
                err_text = await resp.text()
                raise AICQError(
                    f"invoke_agent_stream: fetch challenge failed "
                    f"(HTTP {resp.status}): {err_text}"
                )
            data = await resp.json()
            challenge = data.get("challenge", "")
            if not challenge:
                raise AICQError("invoke_agent_stream: server returned empty challenge")
            return challenge


async def _parse_sse_stream(resp: aiohttp.ClientResponse) -> AsyncIterator[StreamEvent]:
    """Parse a Server-Sent Events stream from an aiohttp response.

    Yields StreamEvent objects as events arrive.
    """
    buffer = ""
    event_type = ""
    data_lines: list[str] = []

    async for raw_chunk in resp.content.iter_any():
        buffer += raw_chunk.decode("utf-8", errors="replace")

        # SSE events are separated by \n\n
        while "\n\n" in buffer:
            event_block, buffer = buffer.split("\n\n", 1)
            ev = _parse_sse_block(event_block)
            if ev:
                yield ev

    # Flush any remaining event
    if buffer.strip():
        ev = _parse_sse_block(buffer)
        if ev:
            yield ev


def _parse_sse_block(block: str) -> Optional[StreamEvent]:
    """Parse one SSE event block (separated by \\n\\n) into a StreamEvent."""
    event_type = ""
    data_lines: list[str] = []

    for line in block.split("\n"):
        if line.startswith("event: "):
            event_type = line[7:].strip()
        elif line.startswith("data: "):
            data_lines.append(line[6:])
        elif line == "data:":
            data_lines.append("")

    if not event_type or not data_lines:
        return None

    data_str = "\n".join(data_lines)
    try:
        data = json.loads(data_str)
    except json.JSONDecodeError:
        data = {"raw": data_str}

    if event_type == "chunk":
        return StreamEvent(
            type="chunk",
            chunk_type=data.get("chunkType", "text"),
            data=data.get("data"),
            from_id=data.get("from", ""),
        )
    elif event_type == "end":
        return StreamEvent(type="end", from_id=data.get("from", ""))
    elif event_type == "cancel":
        return StreamEvent(type="cancel", from_id=data.get("from", ""))
    elif event_type == "error":
        msg = data.get("message", data_str)
        return StreamEvent(type="error", error=AICQError(msg), message=msg)
    elif event_type == "start":
        return StreamEvent(
            type="start",
            target_account_id=data.get("target_account_id", ""),
            target_online=data.get("target_online", False),
            message_id=data.get("message_id", ""),
        )
    elif event_type == "warning":
        return StreamEvent(type="warning", message=data.get("message", ""))
    else:
        return None
