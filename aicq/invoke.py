"""
aicq.invoke — High-level "one-shot" agent invocation helper (Python SDK).

Provides ``invoke_agent_stream``: a single async generator that takes the
sender agent's Ed25519 secret key + a target agent + content (text / file /
image), sends the content to the target, and yields the target's output
stream as ``StreamEvent`` values.

This fills the gap noted in the SDK review: all existing primitives
(``send_message``, ``send_stream_chunk``, ``on_stream_chunk``, ...) are
low-level and require the caller to manually orchestrate auth, WS connect,
callback registration, filtering, and cleanup. ``invoke_agent_stream``
wraps that whole dance into one call.

Architecture::

    sender_sec_key_hex ─┐
                        ├─→ 1. derive pubKey (Ed25519 via pynacl)
                        │   2. inject as "my" agent in a fresh AICQCore
                        │   3. challenge-response login
                        │   4. resolve target (account_id OR public_key hex)
                        │   5. WS connect + online
    target ─────────────┤   6. register on_stream_chunk/End/Cancel filtered by from == target
    content ────────────┤   7. send content (text / upload+media / image-bytes)
                        └─→ 8. yield StreamEvent; return on end/cancel/error/abort

The caller MUST ensure sender and target are already friends on aicq.me.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, Optional, Union

from .core import AICQCore, AICQError, AuthError, AICQConnectionError
from . import crypto

logger = logging.getLogger("aicq.invoke")

DEFAULT_SERVER = "https://aicq.me"
DEFAULT_TIMEOUT_SECONDS = 600.0  # 10 minutes hard cap


# ─── Public types ──────────────────────────────────────────────────


@dataclass
class AgentMessageContent:
    """What to send to the target agent.

    Set exactly one of ``text`` / ``file_path`` / ``file_data`` / ``image``.
    If multiple are set, the first non-empty one wins (in the order
    text → file_path → file_data → image).
    """

    text: Optional[str] = None
    """Plain text message. Highest priority if set."""

    file_path: Optional[str] = None
    """Path to a local file to upload and send as a "file" message."""

    file_data: Optional[bytes] = None
    """Raw file bytes (alternative to file_path). Requires file_name."""

    file_name: Optional[str] = None
    """Required when file_data is set (server needs a name for the upload)."""

    file_mime: Optional[str] = None
    """Optional MIME type override for file_data / file_path."""

    image: Optional[bytes] = None
    """Raw image bytes (shortcut for file_data with an image MIME type)."""

    image_mime: Optional[str] = None
    """MIME type for image. Defaults to image/png."""


@dataclass
class StreamEvent:
    """One event from the target agent's output stream.

    - ``type="chunk"``:  a stream chunk arrived. ``chunk_type`` is "text" /
      "reasoning" / "tool_call" / "image" / etc. ``data`` is the chunk
      payload.
    - ``type="end"``:    the target signaled stream_end.
    - ``type="cancel"``: the target signaled stream_cancel.
    - ``type="error"``:  a fatal error occurred (``error`` is set).
    """

    type: str
    """``"chunk"`` | ``"end"`` | ``"cancel"`` | ``"error"``"""

    chunk_type: str = ""
    """Populated for ``type="chunk"``."""

    data: Any = None
    """Populated for ``type="chunk"``."""

    from_id: str = ""
    """Sender account ID (the target agent)."""

    error: Optional[Exception] = None
    """Populated for ``type="error"``."""


@dataclass
class InvokeAgentStreamOptions:
    """Options for :func:`invoke_agent_stream`."""

    server_url: str = DEFAULT_SERVER
    """Server URL. Default: https://aicq.me."""

    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    """Hard timeout in seconds. Default: 600 (10 minutes)."""

    abort_event: Optional[asyncio.Event] = None
    """Optional asyncio.Event for cancellation. When set, the iterator
    ends with an "error" event."""

    db_path: str = ":memory:"
    """SQLite path for the AICQCore's local DB. Default is in-memory so
    the one-shot invocation doesn't pollute the user's ~/.aicq-sdk/data.db."""


# ─── Public entry point ────────────────────────────────────────────


async def invoke_agent_stream(
    sender_sec_key_hex: str,
    target: str,
    content: AgentMessageContent,
    options: Optional[InvokeAgentStreamOptions] = None,
) -> AsyncIterator[StreamEvent]:
    """One-shot convenience that authenticates as the sender agent (using
    their Ed25519 secret key), sends content to a target agent, and yields
    the target's output stream as :class:`StreamEvent` values.

    Parameters:
        sender_sec_key_hex: SENDER's 64-char hex Ed25519 secret key
            (pynacl format — 32 bytes / 64 hex chars, NOT the 64-byte
            expanded form used by tweetnacl).
        target: TARGET's account ID, OR its 64-char public key (hex).
            If a public key is supplied, it is resolved to an account ID
            via /api/v1/accounts/lookup after login.
        content: What to send (text / file / image).
        options: Optional server URL / timeout / abort event / db_path.

    Yields:
        :class:`StreamEvent` — consume with ``async for ev in ...``.

    Raises:
        :class:`AICQError`: on setup failure (bad key, login failed,
            target resolution failed, WS connect failed, or the initial
            send failed). Once iteration begins, errors surface as
            ``StreamEvent(type="error", error=...)`` rather than raises.

    Friendship requirement: sender and target MUST already be friends on
    aicq.me. If they are not, the initial send will fail with an HTTP error
    and the function raises.

    Example::

        async for ev in invoke_agent_stream(
            sec_key, target_acc_id,
            AgentMessageContent(text="Hello, what's 2+2?"),
        ):
            if ev.type == "chunk" and ev.chunk_type == "text":
                print(ev.data, end="", flush=True)
    """
    if not sender_sec_key_hex:
        raise AICQError("invoke_agent_stream: sender_sec_key_hex is empty")
    if not target:
        raise AICQError("invoke_agent_stream: target is empty")
    _validate_content(content)

    opts = options or InvokeAgentStreamOptions()

    # 1. Build a fresh AICQCore with in-memory DB (one-shot, no pollution)
    core = AICQCore(db_path=opts.db_path, server=opts.server_url)

    # 2. Derive the sender's public key from the secret key.
    #    pynacl's SigningKey is 32 bytes (64 hex chars); the public key
    #    is derived via .verify_key.
    try:
        pub_key_hex = _derive_public_key(sender_sec_key_hex)
    except Exception as e:
        raise AICQError(
            f"invoke_agent_stream: bad sender secret key: {e}"
        ) from e

    # 3. Inject the sender's identity into the core (bypassing DB).
    #    We set self._agent directly because AICQCore doesn't expose a
    #    public "load from keypair" method.
    core._agent = {
        "account_id": "",  # will be filled by login()
        "name": "invoke-sender",
        "type": "my",
        "signing_pub": pub_key_hex,
        "signing_sec": sender_sec_key_hex,
        "exchange_pub": "",
        "exchange_sec": "",
    }

    # 4. Challenge-response login. This populates core.access_token and
    #    core._agent["account_id"] (via the server's login response).
    try:
        await core.login()
    except AuthError as e:
        await core.close()
        raise AICQError(
            f"invoke_agent_stream: sender login failed: {e}"
        ) from e

    # The login() method doesn't update core._agent["account_id"]; we need
    # to fetch it from /accounts/me.
    if not core._agent.get("account_id"):
        try:
            me = await core.get_account()
            # get_account returns dict with "id" or "account_id"
            acct_id = me.get("id") or me.get("account_id") or ""
            if acct_id:
                core._agent["account_id"] = acct_id
        except Exception as e:
            logger.warning("could not fetch sender account_id: %s", e)

    # 5. Resolve target. If `target` looks like a 64-char hex pubkey,
    #    look it up; otherwise treat it as an account_id.
    target_account_id = await _resolve_target(core, target)

    # 6. Connect WS. Must happen before sending.
    try:
        await core.connect()
    except AICQConnectionError as e:
        await core.close()
        raise AICQError(
            f"invoke_agent_stream: WS connect failed: {e}"
        ) from e

    # 7. Set up the event queue + filtered callbacks.
    #    We use an asyncio.Queue so the async generator can pull events
    #    on demand while callbacks push them in real-time.
    queue: "asyncio.Queue[StreamEvent]" = asyncio.Queue(maxsize=128)
    is_done = asyncio.Event()

    def make_enqueue(ev_type: str):
        def _enqueue(data: Dict[str, Any]):
            from_id = data.get("from") or data.get("from_id") or ""
            if from_id != target_account_id:
                # Filter: only forward events from our target.
                return
            if is_done.is_set():
                return
            try:
                if ev_type == "chunk":
                    chunk_type = data.get("chunkType") or data.get("chunk_type") or "text"
                    chunk_data = data.get("data")
                    queue.put_nowait(StreamEvent(
                        type="chunk",
                        chunk_type=chunk_type,
                        data=chunk_data,
                        from_id=from_id,
                    ))
                elif ev_type == "end":
                    queue.put_nowait(StreamEvent(
                        type="end",
                        from_id=from_id,
                    ))
                    # Schedule end-of-stream: small delay to let the
                    # consumer see the "end" event before we tear down.
                    asyncio.get_event_loop().call_later(0.01, is_done.set)
                elif ev_type == "cancel":
                    queue.put_nowait(StreamEvent(
                        type="cancel",
                        from_id=from_id,
                    ))
                    asyncio.get_event_loop().call_later(0.01, is_done.set)
            except asyncio.QueueFull:
                logger.warning("invoke_agent_stream: queue full, dropping event")
        return _enqueue

    core.on_stream_chunk(make_enqueue("chunk"))
    core.on_stream_end(make_enqueue("end"))
    # stream_cancel is dispatched via on_stream_cancel (the SDK's
    # _handle_ws_message sets _stream_cancelled AND dispatches the callback).
    core.on_stream_cancel(make_enqueue("cancel"))

    # 8. Send the content. Failure here raises out of the function.
    try:
        await _send_content(core, target_account_id, content)
    except Exception as e:
        await core.close()
        raise AICQError(
            f"invoke_agent_stream: send content failed: {e}"
        ) from e

    # 9. Watcher tasks: timeout + abort event.
    async def _timeout_watcher():
        try:
            await asyncio.wait_for(is_done.wait(), timeout=opts.timeout_seconds)
        except asyncio.TimeoutError:
            if not is_done.is_set():
                await queue.put(StreamEvent(
                    type="error",
                    error=AICQError(
                        f"invoke_agent_stream: hard timeout ({opts.timeout_seconds}s)"
                    ),
                ))
                is_done.set()
        except asyncio.CancelledError:
            pass

    async def _abort_watcher():
        if opts.abort_event is None:
            return
        try:
            await opts.abort_event.wait()
            if not is_done.is_set():
                await queue.put(StreamEvent(
                    type="error",
                    error=AICQError("invoke_agent_stream: aborted by caller"),
                ))
                is_done.set()
        except asyncio.CancelledError:
            pass

    timeout_task = asyncio.ensure_future(_timeout_watcher())
    abort_task = asyncio.ensure_future(_abort_watcher())

    # 10. Yield events until done.
    try:
        while not is_done.is_set():
            # If queue has events, drain immediately; otherwise wait.
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                # Check is_done again; if set, break.
                if is_done.is_set():
                    break
                continue
            yield ev
            if ev.type in ("end", "cancel", "error"):
                break
    finally:
        # Signal watchers to stop.
        is_done.set()
        timeout_task.cancel()
        abort_task.cancel()
        # Give watchers a moment to clean up.
        for t in (timeout_task, abort_task):
            try:
                await asyncio.wait_for(t, timeout=0.5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        # Tear down WS.
        try:
            await core.close()
        except Exception:
            pass


# ─── Helpers ───────────────────────────────────────────────────────


def _validate_content(c: AgentMessageContent) -> None:
    """Ensure exactly one of text/file_path/file_data/image is set."""
    count = sum([
        1 if c.text else 0,
        1 if c.file_path else 0,
        1 if c.file_data else 0,
        1 if c.image else 0,
    ])
    if count == 0:
        raise AICQError(
            "invoke_agent_stream: content is empty — set one of "
            "text/file_path/file_data/image"
        )
    if count > 1:
        raise AICQError(
            f"invoke_agent_stream: content is ambiguous — set exactly one "
            f"of text/file_path/file_data/image (got {count})"
        )
    if c.file_data and not c.file_name:
        raise AICQError("invoke_agent_stream: file_data requires file_name")


def _derive_public_key(secret_key_hex: str) -> str:
    """Derive the Ed25519 public key (hex) from a pynacl secret key (hex).

    pynacl's SigningKey is 32 bytes (64 hex chars). This is DIFFERENT from
    tweetnacl's 64-byte expanded secret key format used by the Go/Node.js
    SDKs.
    """
    from nacl.signing import SigningKey
    from nacl.encoding import HexEncoder
    sk = SigningKey(secret_key_hex, encoder=HexEncoder)
    return sk.verify_key.encode(encoder=HexEncoder).decode()


_HEX_PUBKEY_RE = re.compile(r"^[0-9a-fA-F]{64}$")


async def _resolve_target(core: AICQCore, target: str) -> str:
    """If `target` is a 64-char hex string, treat it as a public key and
    look it up. Otherwise return it unchanged (assumed to be an account_id).
    """
    if not _HEX_PUBKEY_RE.match(target):
        return target
    try:
        result = await core.lookup_by_public_key(target)
        # lookup_by_public_key returns dict with "account_id" or "id"
        acct_id = result.get("account_id") or result.get("id") or ""
        if not acct_id:
            raise AICQError(
                f"lookup returned no account for public key {target[:8]}..."
            )
        return acct_id
    except AICQError as e:
        raise AICQError(
            f"invoke_agent_stream: resolve target public key failed: {e}"
        ) from e


async def _send_content(
    core: AICQCore,
    target_account_id: str,
    content: AgentMessageContent,
) -> None:
    """Dispatch to the right AICQCore method based on which field of
    AgentMessageContent is set.
    """
    # Case 1: text
    if content.text:
        await core.send_message(target_account_id, content.text)
        return

    # Case 2: file path
    if content.file_path:
        await core.send_file(target_account_id, content.file_path, content.file_mime or "")
        return

    # Case 3: image bytes (shortcut for file_data with image MIME)
    if content.image:
        mime = content.image_mime or "image/png"
        # Write to temp file and use send_file
        tmp_path = await _write_temp_file(content.image, _guess_ext(mime))
        try:
            await core.send_file(target_account_id, tmp_path, mime)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return

    # Case 4: raw file bytes
    if content.file_data:
        mime = content.file_mime or "application/octet-stream"
        # Write to temp file and use send_file (Python SDK's upload_file
        # only accepts a path, so we bridge via tempfile)
        ext = _guess_ext(mime) if mime.startswith("image/") else ""
        tmp_path = await _write_temp_file(
            content.file_data, ext, suffix_name=content.file_name
        )
        try:
            await core.send_file(target_account_id, tmp_path, mime)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return


def _guess_ext(mime: str) -> str:
    """Map a MIME type to a file extension."""
    mapping = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
    }
    return mapping.get(mime.lower(), ".bin")


async def _write_temp_file(
    data: bytes,
    ext: str,
    suffix_name: Optional[str] = None,
) -> str:
    """Write bytes to a temp file and return the path. Runs in a thread
    to avoid blocking the event loop on large files."""
    def _do_write():
        fd, path = tempfile.mkstemp(suffix=ext, prefix="aicq_invoke_")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
        except Exception:
            os.unlink(path)
            raise
        return path
    return await asyncio.get_event_loop().run_in_executor(None, _do_write)
