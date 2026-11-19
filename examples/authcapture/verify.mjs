// Recomputes every hash in terms.base-sepolia.json from the committed documents. Offline; needs only viem
// (installed by `npm install` at the repo root). Run: node examples/authcapture/verify.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256, sha256, toHex } from "viem";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(DIR, f));
const sample = JSON.parse(read("terms.base-sepolia.json").toString("utf8"));

// RFC 8785 (JCS) for JSON values: keys sorted by UTF-16 code units, ECMAScript number/string serialization.
const jcs = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(jcs).join(",")}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;

const pack = (entries) => entries.reduce((t, e, k) => t | (BigInt(e) << BigInt(16 * k)), 0n);
const TERMS_TYPEHASH = keccak256(toHex("AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow)"));
const SALT_TYPEHASH = keccak256(toHex("AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)"));

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);
const t = sample.arbiterTerms;
const ov = sample["outside-verdict"];
const crit = read("criteria.json"), sched = read("schedule.json");

check("criteria.json sha256 == criteriaHash", sha256(crit) === t.criteriaHash);
check("schedule.json sha256 == scheduleHash", sha256(sched) === t.scheduleHash);
check("criteria.json is JCS", jcs(JSON.parse(crit.toString("utf8"))) === crit.toString("utf8"));
check("schedule.json is JCS", jcs(JSON.parse(sched.toString("utf8"))) === sched.toString("utf8"));
check("outside-verdict criteria.sha256 == criteriaHash", ov.terms.criteria.sha256 === t.criteriaHash);
check("payoutBps packs to bpsTable", pack(ov.terms.payoutBps) === BigInt(t.bpsTable));
check("requiredChecks == requiredTotal", ov.terms.requiredChecks === t.requiredTotal);
check("TERMS_TYPEHASH", TERMS_TYPEHASH === t.typehash);
check("AgentKoinTermsSalt typehash", SALT_TYPEHASH === t.saltTypehash);
const th = keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint48" }, { type: "uint32" }],
  [TERMS_TYPEHASH, t.evaluator, t.criteriaHash, t.scheduleHash, t.requiredTotal, BigInt(t.bpsTable), t.submitBy, t.evalWindow],
));
check("termsHash recomputes", th === t.termsHash && th === ov.termsHash);
const c = sample.deployment.config;
check("authorizationExpiryAtLeast", sample.paymentInfoConstraints.authorizationExpiryAtLeast === t.submitBy + t.evalWindow + c.challengeWindow + c.rulingWindow + c.minMarginSeconds);
check("arbitrator zero => challenges disabled", sample.deployment.arbitrator === "0x0000000000000000000000000000000000000000" && sample.deployment.challengesEnabled === false);

for (const [n, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${n}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
