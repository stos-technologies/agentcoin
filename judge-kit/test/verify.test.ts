import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

test("verify: listed in help; bad job id is a usage error (exit 2) without network", () => {
  const h = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(h.stdout, /verify\s+<jobId>/);
  const r = spawnSync(process.execPath, [cli, "verify", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: agentkoin-judge-kit verify <jobId>/);
});

test("verify: src is self-contained (no private-repo paths) and read-only", () => {
  for (const f of ["../src/verify/cli.mjs", "../src/verify/job-proof.mjs", "../src/verify/canonical.mjs"]) {
    const s = readFileSync(here(f), "utf8");
    assert.doesNotMatch(s, /from "\.\.\//, f);
    assert.doesNotMatch(s, /viem\/accounts|writeContract|sendTransaction|privateKey/, f);
  }
});

test("verify: vendored verifier is byte-identical to the service's agent/lib/job-proof.mjs when both exist", { skip: !existsSync(here("../../agent/lib/job-proof.mjs")) }, () => {
  assert.equal(readFileSync(here("../src/verify/job-proof.mjs"), "utf8"), readFileSync(here("../../agent/lib/job-proof.mjs"), "utf8"));
});
