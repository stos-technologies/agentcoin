// Offline unit tests (no anvil, no Forge artifacts). The vectors below were produced by the TS SDK and checked
// against the deployed-source Solidity on a local anvil chain (crosscheck.test.ts, v03.test.ts: run those with
// `npm run test:anvil` from a Foundry workspace that has built ../out). Here the SDK must reproduce them exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAbi, toBytes, type Address } from "viem";
import * as sdk from "../src/index.ts";
import * as v03 from "../src/v03.ts";

const vec = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, f), "utf8"));
const V2 = vec("vectors.v02.json"), V3 = vec("vectors.v03.json");
const BC = "0x" + Buffer.from("bc_ta422vae").toString("hex") + "0b00" + "8021".repeat(8);

test("v0.2 vectors: JCS, resultDigest, termsHash, salt, verdict and acceptance digests", () => {
  assert.equal(sdk.canonicalJson(V2.json), V2.jcs);
  assert.equal(sdk.resultDigestJson(V2.json), V2.resultDigestJson);
  assert.equal(sdk.resultDigest(toBytes("agentkoin sample result bytes v1")), V2.resultDigestBytes);
  const t: sdk.Terms = { ...V2.terms, bpsTable: BigInt(V2.terms.bpsTable) };
  assert.equal(sdk.termsHash(t), V2.termsHash);
  assert.equal(`0x${sdk.termsSalt(sdk.termsHash(t), 42n).toString(16)}`, V2.termsSalt42);
  assert.equal(sdk.verdictDigest(V2.chainId, V2.arbiter, V2.verdict), V2.verdictDigest);
  assert.equal(sdk.buyerAcceptanceDigest(V2.chainId, V2.arbiter, V2.acceptance), V2.acceptanceDigest);
  assert.deepEqual([sdk.TERMS_TYPEHASH, sdk.AGK_SALT_TYPEHASH, sdk.OUTSIDE_VERDICT_TYPEHASH, sdk.BUYER_ACCEPTANCE_TYPEHASH],
    [V2.typehashes.terms, V2.typehashes.salt, V2.typehashes.verdict, V2.typehashes.acceptance]);
});

test("v0.3 vectors: TERMS_TYPEHASH (matches the deployed contract), termsHash binds submitter, 0.3 domain", () => {
  assert.equal(v03.TERMS_V03_TYPEHASH, "0x8b1eaa5ae5d3eb6c995dcc79a0cf4244003358020d8a691f033b780ae1507cd4");
  assert.equal(v03.TERMS_V03_TYPEHASH, V3.typehashes.terms);
  const t: v03.TermsV03 = { ...V3.terms, bpsTable: BigInt(V3.terms.bpsTable) };
  assert.equal(v03.hashTermsV03(t), V3.termsHash);
  assert.equal(v03.hashTermsV03({ ...t, submitter: sdk.ZERO }), V3.termsHashZeroSubmitter);
  assert.equal(`0x${v03.termsSalt(v03.hashTermsV03(t), 42n).toString(16)}`, V3.termsSalt42);
  assert.deepEqual(v03.buildVerdictV03({ paymentInfoHash: V3.verdict.paymentInfoHash, terms: t, deliverableHash: V3.verdict.deliverableHash,
    resultDigest: V3.verdict.resultDigest, passMask: V3.verdict.passMask, reasonHash: V3.verdict.reasonHash }), V3.verdict);
  assert.equal(v03.verdictDigestV03(V3.chainId, V3.arbiter, V3.verdict), V3.verdictDigest);
  assert.equal(sdk.verdictDigest(V3.chainId, V3.arbiter, V3.verdict), V3.verdictDigestV02Domain);
  assert.notEqual(V3.verdictDigest, V3.verdictDigestV02Domain);
  assert.equal(v03.buyerAcceptanceDigestV03(V3.chainId, V3.arbiter, V3.acceptance), V3.acceptanceDigest);
});

test("v0.3 domain separator for the Base Sepolia deployment matches the on-chain value", () => {
  // read with: cast call 0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5 "domainSeparator()(bytes32)" --rpc-url https://sepolia.base.org
  assert.equal(v03.domainSeparatorV03(84532, "0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5"), "0xc3c3f7231c732a39b75e4d92b8a644a34fc05c182f030090ca96bde52fc59a9f");
});

test("v0.3 role guards: SubmitterIsPayer and effectiveSubmitter", () => {
  const payer: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", seller: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const dep: Address = "0x3b0b371ae3cB08F272b87319684f6518b3b313a0";
  const t: v03.TermsV03 = { ...V3.terms, bpsTable: BigInt(V3.terms.bpsTable) };
  assert.equal(v03.effectiveSubmitter({ receiver: dep }, { ...t, submitter: sdk.ZERO }), dep);
  assert.equal(v03.effectiveSubmitter({ receiver: dep }, { ...t, submitter: seller }), seller);
  assert.ok(v03.submitterIsPayer({ payer, receiver: dep }, { ...t, submitter: payer.toLowerCase() as Address }));
  assert.ok(v03.submitterIsPayer({ payer, receiver: payer }, { ...t, submitter: sdk.ZERO }));
  assert.ok(!v03.submitterIsPayer({ payer, receiver: dep }, { ...t, submitter: seller }));
});

test("ERC-8021 builder code: default bc_ta422vae, opt-out, append", () => {
  assert.equal(sdk.DEFAULT_BASE_BUILDER_CODE, "bc_ta422vae");
  assert.equal(sdk.encodeBuilderCodeSuffix("bc_ta422vae"), BC);
  assert.equal(sdk.resolveBuilderCode(undefined, {}), "bc_ta422vae");
  for (const v of ["", "none", "0"]) assert.equal(sdk.resolveBuilderCode(undefined, { BASE_BUILDER_CODE: v }), null);
  assert.equal(sdk.appendBuilderCodeSuffix("0xdeadbeef", null), "0xdeadbeef");
  assert.deepEqual(sdk.decodeBuilderCodeSuffix(sdk.appendBuilderCodeSuffix("0xdeadbeef", "bc_ta422vae"))?.codes, ["bc_ta422vae"]);
  const abi = parseAbi(["function ping(uint256 x)"]);
  const on = sdk.buildArbiterTx({ address: "0x0000000000000000000000000000000000000001", abi, functionName: "ping", args: [1n], env: {} });
  const off = sdk.buildArbiterTx({ address: "0x0000000000000000000000000000000000000001", abi, functionName: "ping", args: [1n], builderCode: null });
  assert.equal(on.data, off.data + BC.slice(2));
});
