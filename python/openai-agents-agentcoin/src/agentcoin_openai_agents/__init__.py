"""AgentCoin tools for the OpenAI Agents SDK (Python). Base Sepolia testnet only."""
from __future__ import annotations

import asyncio
import json

from agentcoin_core import TOOL_SPECS, as_client, run_tool_json
from agents import FunctionTool


def agentcoin_tools(client=None, *, include: list[str] | None = None, read_only: bool = False) -> list[FunctionTool]:
    """FunctionTools for `Agent(tools=...)`. Non-strict JSON schema (optional fields allowed)."""
    c = as_client(client)
    out = []
    for spec in TOOL_SPECS:
        if (include and spec["name"] not in include) or (read_only and not spec["readOnly"]):
            continue

        def make(name):
            async def invoke(_ctx, args_json: str) -> str:
                try:
                    args = json.loads(args_json or "{}")
                except ValueError as e:
                    return json.dumps({"error": "bad_args", "message": f"invalid JSON arguments: {e}"})
                return await asyncio.to_thread(run_tool_json, c, name, args)

            return invoke

        out.append(FunctionTool(name=spec["name"], description=spec["description"], params_json_schema=spec["parameters"], on_invoke_tool=make(spec["name"]), strict_json_schema=False))
    return out


__all__ = ["agentcoin_tools"]
