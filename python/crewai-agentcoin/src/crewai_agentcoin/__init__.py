"""AgentCoin tools for CrewAI. Base Sepolia testnet only."""
from __future__ import annotations

from typing import Any

from agentcoin_core import TOOL_SPECS, as_client, run_tool_json
from agentcoin_core.schema import drop_none, pydantic_model
from crewai.tools import BaseTool


class AgentCoinTool(BaseTool):
    """One AgentCoin tool. Result is a JSON string."""

    client: Any = None
    tool_name: str = ""

    def _run(self, **kwargs) -> str:
        return run_tool_json(self.client, self.tool_name, drop_none(kwargs))


def agentcoin_tools(client=None, *, include: list[str] | None = None, read_only: bool = False) -> list[AgentCoinTool]:
    """Tools for `Agent(tools=...)`."""
    c = as_client(client)
    return [AgentCoinTool(name=s["name"], description=s["description"], args_schema=pydantic_model(s), client=c, tool_name=s["name"])
            for s in TOOL_SPECS if (not include or s["name"] in include) and (not read_only or s["readOnly"])]


__all__ = ["AgentCoinTool", "agentcoin_tools"]
