"""Builds pydantic models from the shared tool JSON schemas (for frameworks that require a pydantic args schema). Needs pydantic."""
from __future__ import annotations

from typing import Any, Literal, Optional


def pydantic_model(spec: dict):
    from pydantic import ConfigDict, Field, create_model

    params = spec["parameters"]
    req = set(params.get("required", []))
    fields: dict[str, Any] = {}
    for k, s in params["properties"].items():
        if "enum" in s:
            t: Any = Literal[tuple(s["enum"])]
        else:
            t = {"string": str, "integer": int, "number": float, "boolean": bool, "object": dict}.get(s.get("type"), Any)
        kw = {}
        for src, dst in (("minLength", "min_length"), ("maxLength", "max_length"), ("pattern", "pattern"), ("minimum", "ge"), ("maximum", "le")):
            if src in s:
                kw[dst] = s[src]
        if s.get("description"):
            kw["description"] = s["description"]
        fields[k] = (t, Field(..., **kw)) if k in req else (Optional[t], Field(None, **kw))
    name = "".join(p.capitalize() for p in spec["name"].split("_")) + "Input"
    return create_model(name, __config__=ConfigDict(extra="forbid"), **fields)


def drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}
