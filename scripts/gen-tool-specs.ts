// Writes core-ts toolSpecs to the Python core so both languages share one tool definition.
import { writeFileSync } from "node:fs";
import { toolSpecs } from "../core-ts/src/tools.ts";
const out = new URL("../python/agentcoin-core/src/agentcoin_core/tool_specs.json", import.meta.url);
writeFileSync(out, JSON.stringify(toolSpecs, null, 2) + "\n");
console.log("wrote", out.pathname, toolSpecs.length);
