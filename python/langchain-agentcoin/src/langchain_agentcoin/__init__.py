"""AgentCoin tools for LangChain / LangGraph (Python). Base Sepolia testnet only."""
from __future__ import annotations

import asyncio

from agentcoin_core import TOOL_SPECS, as_client, run_tool_json
from agentcoin_core.schema import drop_none
from langchain_core.tools import StructuredTool


def agentcoin_tools(client=None, *, include: list[str] | None = None, read_only: bool = False) -> list[StructuredTool]:
    """StructuredTools for create_react_agent / ToolNode / model.bind_tools. Output is a JSON string."""
    c = as_client(client)
    out = []
    for spec in TOOL_SPECS:
        if (include and spec["name"] not in include) or (read_only and not spec["readOnly"]):
            continue

        def make(name):
            def fn(**kw):
                return run_tool_json(c, name, drop_none(kw))

            async def afn(**kw):
                return await asyncio.to_thread(fn, **kw)

            return fn, afn

        fn, afn = make(spec["name"])
        out.append(StructuredTool.from_function(func=fn, coroutine=afn, name=spec["name"], description=spec["description"], args_schema=spec["parameters"]))
    return out


__all__ = ["agentcoin_tools"]
