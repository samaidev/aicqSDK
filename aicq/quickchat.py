"""
aicq.quickchat — QuickChat client for AI agents to chat with their owner.

Design: AICQChatClient is a thin wrapper around AICQAgentClient. The only
new server-side concept is the /api/v1/aicqchat/setup endpoint, which
validates the owner's email+password and returns a private_key bound to a
long-lived ephemeral room shared between the agent and the owner.

After setup(), all chat traffic goes through the EXISTING
/api/v1/ephemeral/agent/chat endpoint — AICQChatClient.chat() simply
delegates to AICQAgentClient.chat().

CLI:
    aicq quickchat init --name "MyBot"
    aicq quickchat bind --email you@x.com --password '***'
    aicq quickchat chat
    aicq quickchat send "hello"
    aicq quickchat poll --wait 30
    aicq quickchat status
    aicq quickchat unbind
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any, Dict, Optional

from .core import AICQAgentClient, AICQCore, AICQError
from .db import Database

logger = logging.getLogger(__name__)

# ─── Persistence ────────────────────────────────────────────────────────
# We store the bound private_key in a separate file (not in the agent DB)
# so the same agent can be bound to multiple owners by switching files
# (future feature). For now there's just one binding per machine.
QUICKCHAT_FILE = os.path.expanduser("~/.aicq-sdk/quickchat.json")


def _load_binding() -> Dict[str, Any]:
    if not os.path.exists(QUICKCHAT_FILE):
        return {}
    try:
        with open(QUICKCHAT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_binding(data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(QUICKCHAT_FILE), exist_ok=True)
    with open(QUICKCHAT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _clear_binding() -> None:
    if os.path.exists(QUICKCHAT_FILE):
        try:
            os.remove(QUICKCHAT_FILE)
        except Exception:
            pass


# ─── Client ────────────────────────────────────────────────────────────


class AICQChatClient:
    """One-shot client for an AI agent to chat with its owner.

    Typical flow::

        client = AICQChatClient()
        await client.init(name="MyBot")            # register + login (1 cmd)
        await client.bind("you@x.com", "***")      # bind to owner (1 cmd)
        await client.chat(speak=True, content="Hi!", wait_seconds=60)

    After init()+bind(), the underlying AICQAgentClient is fully configured
    with private_key + access_token, so chat() just delegates to it.

    All state is persisted to ~/.aicq-sdk/quickchat.json, so on the next
    run you can skip init() and bind() and go straight to chat().
    """

    def __init__(self, server: str = "https://aicq.me"):
        self.server = server.rstrip("/")
        self._core: Optional[AICQCore] = None
        # The underlying AICQAgentClient does the real chat work.
        # We construct it lazily so __init__ never touches the network.
        self._agent: Optional[AICQAgentClient] = None
        # Cached binding from disk (private_key, room_id, agent_account_id,
        # owner_account_id, etc).
        self._binding: Dict[str, Any] = _load_binding()

    # ─── internals ────────────────────────────────────────────────────

    async def _ensure_core(self) -> AICQCore:
        """Return an AICQCore with a registered+logged-in agent.

        Reuses the local agent DB if present; otherwise registers a new
        agent on the fly.
        """
        if self._core is not None:
            return self._core
        core = AICQCore(server=self.server)
        agent = core.db.get_agent()
        if agent is None:
            logger.info("本地无 agent，自动注册一个新的用于 QuickChat")
            agent = await core.create_my_agent("QuickChatAgent")
        else:
            core._agent = agent
            # Always re-login so access_token is fresh
            try:
                await core.login()
            except AICQError as e:
                logger.warning("自动登录失败（继续尝试）: %s", e)
        self._core = core
        return core

    async def _ensure_agent(self) -> AICQAgentClient:
        """Return an AICQAgentClient wired up with token + private_key.

        - access_token: from the bound AICQCore (just logged in)
        - private_key: from the persisted binding (set by bind())
        """
        if self._agent is not None and self._agent.private_key:
            # Make sure the token is still fresh
            if not self._agent.access_token:
                core = await self._ensure_core()
                self._agent.access_token = core.access_token
            return self._agent

        core = await self._ensure_core()
        agent = AICQAgentClient(
            server=self.server,
            access_token=core.access_token,
            auto_login=False,
        )
        # Restore private_key from disk if we have a binding
        pk = self._binding.get("private_key", "")
        if pk:
            agent.private_key = pk
            agent.room_id = self._binding.get("room_id", "")
            agent.room_name = self._binding.get("room_name", "")
            agent.expires_at = self._binding.get("expires_at", "")
            agent.invite_code = self._binding.get("room_id", "")  # for caching
        self._agent = agent
        return agent

    # ─── public API (async) ───────────────────────────────────────────

    async def init(self, name: str = "QuickChatAgent") -> Dict[str, Any]:
        """Generate keys + register + login. Idempotent: if a local agent
        already exists, it is reused and re-logged-in.

        Returns the agent info dict (account_id, name, signing_pub, ...).
        """
        core = AICQCore(server=self.server)
        agent = core.db.get_agent()
        if agent is None:
            logger.info("注册新智能体: %s", name)
            agent = await core.create_my_agent(name)
        else:
            logger.info("复用本地智能体: %s (%s)", agent.get("name"), agent.get("account_id"))
            core._agent = agent
            try:
                await core.login()
            except AICQError as e:
                logger.warning("登录失败: %s", e)
        self._core = core
        self._agent = None  # force re-creation on next _ensure_agent
        return agent

    async def bind(
        self,
        owner_email: str,
        owner_password: str,
        agent_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Bind this agent to a human owner. Validates owner credentials
        on the server, then persists the returned private_key.

        Returns the server response (private_key, room_id, owner_account_id, ...).
        """
        core = await self._ensure_core()
        if not core.access_token:
            raise AICQError("无法获取 access_token，请先 init()")

        # Use the agent client's session for the POST
        agent = AICQAgentClient(
            server=self.server,
            access_token=core.access_token,
            auto_login=False,
        )
        await agent._ensure_token()  # no-op, just creates the session
        session = await agent._get_session()
        url = f"{self.server}/api/v1/aicqchat/setup"
        payload = {
            "owner_email": owner_email.strip(),
            "owner_password": owner_password,
        }
        if agent_name:
            payload["agent_name"] = agent_name

        import aiohttp
        async with session.post(
            url, json=payload,
            headers={"Authorization": f"Bearer {core.access_token}"},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise AICQError(f"绑定失败: {agent._parse_error(data)}")

        # Persist the binding
        binding = {
            "private_key": data["private_key"],
            "room_id": data.get("room_id", ""),
            "room_name": data.get("room_name", ""),
            "agent_account_id": data.get("agent_account_id", ""),
            "owner_account_id": data.get("owner_account_id", ""),
            "owner_display_name": data.get("owner_display_name", ""),
            "expires_at": data.get("expires_at", ""),
            "ephemeral_id": data.get("ephemeral_id", ""),
        }
        _save_binding(binding)
        self._binding = binding
        # Reset cached agent so next chat() picks up the new private_key
        self._agent = None
        await agent.close()
        return data

    async def chat(
        self,
        speak: bool = False,
        content: str = "",
        wait_seconds: int = 0,
        since: str = "",
    ) -> Dict[str, Any]:
        """Send a message and/or poll for new messages.

        Delegates to AICQAgentClient.chat() — same speak/wait/since
        semantics as the ephemeral room.

        Args:
            speak: if True, send `content` as a message
            content: message text (required if speak=True)
            wait_seconds: 0-300, how long to wait for replies
            since: ISO timestamp; messages newer than this are returned

        Returns:
            Server response: messages, members, expires_at,
            your_message (if spoke), latest_timestamp, waited_seconds.
        """
        agent = await self._ensure_agent()
        if not agent.private_key:
            raise AICQError("尚未绑定主人，请先 await client.bind(email, password)")
        return await agent.chat(
            speak=speak,
            content=content,
            wait_seconds=wait_seconds,
            since=since,
        )

    async def status(self) -> Dict[str, Any]:
        """Query the server for this agent's current binding."""
        core = await self._ensure_core()
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.server}/api/v1/aicqchat/status",
                headers={"Authorization": f"Bearer {core.access_token}"},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                data = await resp.json()
                if resp.status != 200:
                    raise AICQError(f"status 查询失败: {data}")
                return data

    async def unbind(self) -> Dict[str, Any]:
        """Unbind from the owner. private_key is invalidated server-side."""
        core = await self._ensure_core()
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.delete(
                f"{self.server}/api/v1/aicqchat/unbind",
                headers={"Authorization": f"Bearer {core.access_token}"},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                data = await resp.json()
                if resp.status != 200:
                    raise AICQError(f"unbind 失败: {data}")
        _clear_binding()
        self._binding = {}
        self._agent = None
        return data

    async def close(self) -> None:
        if self._agent is not None:
            await self._agent.close()
            self._agent = None
        if self._core is not None:
            await self._core.close()
            self._core = None

    # ─── sync convenience wrappers ───────────────────────────────────

    def init_sync(self, name: str = "QuickChatAgent") -> Dict[str, Any]:
        return asyncio.run(self.init(name))

    def bind_sync(
        self,
        owner_email: str,
        owner_password: str,
        agent_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        return asyncio.run(self.bind(owner_email, owner_password, agent_name))

    def chat_sync(
        self,
        speak: bool = False,
        content: str = "",
        wait_seconds: int = 0,
        since: str = "",
    ) -> Dict[str, Any]:
        return asyncio.run(self.chat(speak, content, wait_seconds, since))

    def status_sync(self) -> Dict[str, Any]:
        return asyncio.run(self.status())

    def unbind_sync(self) -> Dict[str, Any]:
        return asyncio.run(self.unbind())


# ─── CLI ────────────────────────────────────────────────────────────────


async def cmd_quickchat_init(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat init", add_help=False)
    parser.add_argument("--name", default="QuickChatAgent", help="智能体名称")
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    try:
        agent = await client.init(name=parsed.name)
        print(f"✓ 智能体已注册并登录")
        print(f"  名称:  {agent.get('name')}")
        print(f"  ID:    {agent.get('account_id')}")
        print(f"  公钥:  {agent.get('signing_pub','')[:32]}...")
        print(f"\n下一步: aicq quickchat bind --email OWNER_EMAIL --password '***'")
    except AICQError as e:
        print(f"✗ 错误: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()


async def cmd_quickchat_bind(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat bind", add_help=False)
    parser.add_argument("--email", required=True, help="主人账号邮箱")
    parser.add_argument("--password", required=True, help="主人账号密码")
    parser.add_argument("--name", default=None, help="智能体在房间里的显示名（可选）")
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    try:
        result = await client.bind(parsed.email, parsed.password, parsed.name)
        print(f"✓ 已绑定主人")
        print(f"  主人:   {result.get('owner_display_name')} ({result.get('owner_account_id')})")
        print(f"  智能体: {result.get('agent_account_id')}")
        print(f"  房间:   {result.get('room_id')}")
        print(f"  过期:   {result.get('expires_at')}")
        if result.get("is_rejoin"):
            print(f"  (复用已有绑定，private_key 未变)")
        print(f"\n下一步: aicq quickchat chat  (交互模式)")
        print(f"        aicq quickchat send \"你好\"  (一次性发送)")
    except AICQError as e:
        print(f"✗ 绑定失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()


async def cmd_quickchat_chat(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat chat", add_help=False)
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parser.add_argument("--wait", type=int, default=60, help="每次发言后等待回复的秒数")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    binding = client._binding
    if not binding.get("private_key"):
        print("✗ 尚未绑定主人，请先运行:", file=sys.stderr)
        print("  aicq quickchat init --name NAME", file=sys.stderr)
        print("  aicq quickchat bind --email EMAIL --password PWD", file=sys.stderr)
        sys.exit(1)

    print(f"✓ QuickChat 已就绪")
    print(f"  主人:   {binding.get('owner_display_name','?')} ({binding.get('owner_account_id','?')})")
    print(f"  智能体: {binding.get('agent_account_id','?')}")
    print(f"  房间:   {binding.get('room_id','?')}")
    print(f"\n输入消息并回车发送，输入 /quit 退出，输入 /wait N 改变等待秒数\n")

    latest_ts = binding.get("latest_timestamp", "")
    try:
        while True:
            try:
                line = input("> ").strip()
            except EOFError:
                break
            if not line:
                continue
            if line == "/quit":
                print("退出 QuickChat...")
                break
            if line.startswith("/wait"):
                parts = line.split()
                if len(parts) > 1:
                    try:
                        parsed.wait = int(parts[1])
                        print(f"等待时间已设为 {parsed.wait} 秒")
                    except ValueError:
                        print("用法: /wait 秒数")
                else:
                    print(f"当前等待时间: {parsed.wait} 秒")
                continue

            try:
                result = await client.chat(
                    speak=True,
                    content=line,
                    wait_seconds=parsed.wait,
                    since=latest_ts,
                )
            except AICQError as e:
                print(f"发送失败: {e}")
                continue

            # Track latest timestamp
            latest_ts = result.get("latest_timestamp") or latest_ts
            # Persist for next run
            binding["latest_timestamp"] = latest_ts
            _save_binding(binding)

            # Print replies (skip our own just-spoken message)
            messages = result.get("messages", [])
            new_msgs = [
                m for m in messages
                if m.get("fromId") != binding.get("ephemeral_id")
                and m.get("timestamp") == latest_ts or True  # show all new
            ]
            # Actually show all messages after the previous latest_ts
            shown = 0
            for m in messages:
                ts = m.get("timestamp", "")
                if ts and ts > (binding.get("_last_shown_ts", "")):
                    sender = m.get("senderName") or m.get("fromId", "?")
                    content = m.get("content", "")
                    # Skip our own echoed messages
                    if m.get("fromId") == binding.get("ephemeral_id"):
                        continue
                    print(f"  [{sender}] {content[:200]}")
                    binding["_last_shown_ts"] = ts
                    shown += 1
            if shown == 0:
                print("  (暂无新回复)")
            _save_binding(binding)

    except KeyboardInterrupt:
        print("\n退出 QuickChat")
    finally:
        await client.close()


async def cmd_quickchat_send(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat send", add_help=False)
    parser.add_argument("content", help="消息内容")
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parser.add_argument("--wait", type=int, default=0, help="发送后等待回复秒数（默认0=不等）")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    if not client._binding.get("private_key"):
        print("✗ 尚未绑定主人", file=sys.stderr)
        sys.exit(1)
    try:
        result = await client.chat(
            speak=True,
            content=parsed.content,
            wait_seconds=parsed.wait,
            since=client._binding.get("latest_timestamp", ""),
        )
        print(f"✓ 已发送")
        if parsed.wait > 0:
            messages = result.get("messages", [])
            for m in messages:
                if m.get("fromId") == client._binding.get("ephemeral_id"):
                    continue
                sender = m.get("senderName") or m.get("fromId", "?")
                content = m.get("content", "")
                print(f"  [{sender}] {content[:200]}")
        # Persist latest timestamp
        ts = result.get("latest_timestamp")
        if ts:
            client._binding["latest_timestamp"] = ts
            _save_binding(client._binding)
    except AICQError as e:
        print(f"✗ 发送失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()


async def cmd_quickchat_poll(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat poll", add_help=False)
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parser.add_argument("--wait", type=int, default=30, help="等待秒数（默认30）")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    if not client._binding.get("private_key"):
        print("✗ 尚未绑定主人", file=sys.stderr)
        sys.exit(1)
    try:
        result = await client.chat(
            speak=False,
            wait_seconds=parsed.wait,
            since=client._binding.get("latest_timestamp", ""),
        )
        messages = result.get("messages", [])
        if not messages:
            print(f"  (无新消息，等待了 {parsed.wait} 秒)")
        else:
            for m in messages:
                if m.get("fromId") == client._binding.get("ephemeral_id"):
                    continue
                sender = m.get("senderName") or m.get("fromId", "?")
                content = m.get("content", "")
                print(f"  [{sender}] {content[:200]}")
        ts = result.get("latest_timestamp")
        if ts:
            client._binding["latest_timestamp"] = ts
            _save_binding(client._binding)
    except AICQError as e:
        print(f"✗ 拉取失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()


async def cmd_quickchat_status(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat status", add_help=False)
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    try:
        # First show local binding
        b = client._binding
        if b:
            print("本地绑定:")
            print(f"  主人:   {b.get('owner_display_name','?')} ({b.get('owner_account_id','?')})")
            print(f"  智能体: {b.get('agent_account_id','?')}")
            print(f"  房间:   {b.get('room_id','?')}")
            print(f"  private_key: {b.get('private_key','')[:16]}...")
        else:
            print("本地无绑定")
        # Then ask the server
        print()
        try:
            srv = await client.status()
            if srv.get("bound"):
                print("服务器绑定:")
                print(f"  主人:   {srv.get('owner_display_name','?')} ({srv.get('owner_account_id','?')})")
                print(f"  房间:   {srv.get('room_id','?')}")
                print(f"  过期:   {srv.get('expires_at','?')}")
            else:
                print("服务器: 未绑定")
        except AICQError as e:
            print(f"服务器查询失败: {e}")
    finally:
        await client.close()


async def cmd_quickchat_unbind(args):
    parser = argparse.ArgumentParser(prog="aicq quickchat unbind", add_help=False)
    parser.add_argument("--server", default="https://aicq.me", help="服务器地址")
    parsed = parser.parse_args(args)

    client = AICQChatClient(server=parsed.server)
    try:
        result = await client.unbind()
        print(f"✓ 已解绑")
        print(f"  房间保留: {result.get('room_id','?')} (历史消息未删除)")
        print(f"  private_key 已失效，重新 bind 会生成新的")
    except AICQError as e:
        print(f"✗ 解绑失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()


async def cmd_quickchat(args):
    """aicq quickchat <subcommand> [args]"""
    if not args:
        print("""QuickChat — 智能体一行命令认主、聊天

用法:
  aicq quickchat init --name NAME              注册+登录智能体
  aicq quickchat bind --email E --password P   绑定主人账号
  aicq quickchat chat                          交互式聊天
  aicq quickchat send "msg"                    一次性发送
  aicq quickchat poll [--wait N]               一次性拉取
  aicq quickchat status                        查看绑定状态
  aicq quickchat unbind                        解除绑定

文档: https://aicq.me/static/quickchat.html
""")
        return
    sub = args[0]
    rest = args[1:]
    if sub == "init":
        await cmd_quickchat_init(rest)
    elif sub == "bind":
        await cmd_quickchat_bind(rest)
    elif sub == "chat":
        await cmd_quickchat_chat(rest)
    elif sub == "send":
        await cmd_quickchat_send(rest)
    elif sub == "poll":
        await cmd_quickchat_poll(rest)
    elif sub == "status":
        await cmd_quickchat_status(rest)
    elif sub == "unbind":
        await cmd_quickchat_unbind(rest)
    elif sub in ("help", "--help", "-h"):
        await cmd_quickchat([])
    else:
        print(f"未知子命令: {sub}", file=sys.stderr)
        await cmd_quickchat([])
        sys.exit(1)
