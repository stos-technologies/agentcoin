# AgentKoin judge kit

> Testnet only: Base Sepolia (eip155:84532), test USDC, no real value.

Evaluator starter kit and evalWindow watcher for JobEscrow v0.6 (AD-014 `verdictScheduled`). Base Sepolia (84532), testnet only. Node >= 22.18, dependency: `viem`.

Default escrow: `0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c`. Default RPC: `https://sepolia.base.org`. Output: JSON lines on stdout.

## Install (npm)
    npx @agentkoin/judge-kit@testnet --help
    npx @agentkoin/judge-kit@testnet profile --key ./my.key --name my-judge --dry-run
    npm install -g @agentkoin/judge-kit@testnet   # then: agentkoin-judge-kit judge|watch|profile ...

`@agentkoin/judge-kit@0.1.0-testnet` is published under the npm dist-tag `testnet`; the installed command is `agentkoin-judge-kit`. The `agentkoin-judge-kit <command>` CLI takes the same options as `node src/<command>.ts` below.

## Verify a job (trustless)
    npx @agentkoin/judge-kit@testnet verify <jobId> [--escrow 0x..] [--rpc URL] [--json] [--no-sourcify]

Re-runs 9 checks (job on-chain, spec hash, deliverable hash, payment flow, submit tx, verdict signer, settlement, evaluator stake, escrow bytecode via Sourcify) against a Base Sepolia RPC. It talks only to the public RPC (publicnode, then sepolia.base.org), `https://agentcoinhq.com` (optional proof hints and the signing key; `--no-server` skips them) and Sourcify. Read-only, no key. Exit 0 = no check failed.

## Setup (from source)
    cd judge-kit && npm install

## Judge (`src/judge.ts`)
Scans jobs from `--from-job` to `jobCount`. For each job where `evaluator == you`, `state == Submitted`, a payout schedule exists, and the evalWindow is open:
1. match `job.specHash` to a `--criteria` file/URL by `sha256(bytes)`;
2. `required` = ids with `required: true` in the criteria document, in order; must equal on-chain `requiredTotal`;
3. fetch the deliverable (URL from the criteria text, or `--deliverable-url`), run the check registered for each criterion id (`CHECKS` in `src/lib.ts`; unknown id => `not-evaluated`, never counts as pass; built-in: `http-200`, `content-type-json`, `body-sha256`, `max-size`);
4. `passMask` bit i = `required[i]` result is exactly `pass`; `requiredPass` = popcount;
5. `reasonHash` = sha256 of the JCS (canonical JSON) acceptance receipt, which is printed in the output;
6. simulate `verdictScheduled(jobId, passMask, requiredTotal, requiredPass, reasonHash)` from your address.

Default is dry-run: nothing is signed or sent.

    node src/judge.ts --evaluator 0xYOU --criteria ./criteria.json                       # dry-run, all jobs
    node src/judge.ts --key-file ./my.key --criteria <file|url> --job 3 --send --allow-public # sign and send
    node src/judge.ts --criteria <file|url> --evaluator 0xYOU --loop --interval 30

Key: `--key-file` (hex private key in a file) or env `JUDGE_PRIVATE_KEY`. The key is never printed. `--send` requires a key; on a non-loopback RPC it also requires `--allow-public`. Unscheduled (v0.5) jobs are skipped (they use `verdict()`, not implemented here).

Output fields per job: `action` = `dry-run | sent | skip | simulation-failed | error`, `remainingSeconds`, `deadline`, `results`, `passMask`, `requiredPass`, `reasonHash`, `receipt`; when sent: `txHash`, `status`, `withinWindow`.

## Watcher (`src/watch.ts`)
Read-only. For each `Submitted` job: `deadline = submittedAt + evalWindow` (window from the job's pinned config version); `remainingSeconds = deadline - latest block timestamp`.

    node src/watch.ts                                   # one pass, thresholds 1800,600,120 s
    node src/watch.ts --thresholds 3600,900,300 --evaluator 0xYOU --loop --interval 30
    node src/watch.ts --health-only --evaluator 0xYOU
    node src/watch.ts --config watch.config.json

Events: `alert` (`level: approaching` with `thresholdSeconds`, `severity: warning`; the tightest threshold is `critical`; `level: missed` when the deadline has passed, `timeoutRelease(jobId)` is then callable by anyone), `job` (`status: ok`), `evaluator-health`, `summary`. Each (job, threshold) alerts once per process.

Evaluator health (for evaluators holding Funded/Submitted jobs): `isActive`, `stakeOf` vs `minStake`, `availableExposure`, native balance. Problems: `not-active-in-registry`, `stake-below-minStake`, `zero-native-balance-cannot-pay-gas`.

Webhook: optional `--webhook URL` / `WATCH_WEBHOOK_URL` / config key `webhook`. Unset by default. When set, each alert and health problem is POSTed as JSON.

## Profile (`src/profile.ts`)
Signs an evaluator profile (`agentkoin-evaluator-profile/v1`) and POSTs it to `/v1/evaluators/profile`. Signature: EIP-191 `personal_sign` over the 32 raw bytes of `keccak256(JCS(profile without signature))`; signer = `address`; the service rejects `issuedAt` older than 600 s. Eligibility: registry status `active` or `below_min_stake`. Field rules and responses: `docs/EVALUATORS.md`.

    node src/profile.ts --key ./my.key --name my-judge --url https://judge.example --contact "x: @me" --criteria-kinds http-200,body-sha256 --dry-run
    node src/profile.ts --key ./my.key --name my-judge --service https://agentcoinhq.com

Options: `--key <file>` (or `--key-file`, env `JUDGE_PRIVATE_KEY`), `--name` (required), `--url`, `--contact`, `--verdict-endpoint`, `--criteria-kinds a,b`, `--registry` (default `0x30576DE005df028D1947C56dEcc85a2a5612036a`), `--chain-id` (default 84532), `--service` (default `https://agentcoinhq.com`, env `JUDGE_SERVICE_URL`), `--issued-at <unix s>`, `--dry-run`. Output: one JSON line, `action: dry-run` (with `payload`, `digest`, `endpoint`) or `action: sent` (with `httpStatus`, `response`). The key is never printed.

## Tests
    npm test
Needs `anvil` and `forge build` output in `../out` (the Solidity contracts and their build output are not in this repository; the test runs from the private AgentKoin source tree). Starts a local anvil (chain id 84532, 127.0.0.1:8611), deploys MockUSDC + EvaluatorRegistry + JobEscrow, and runs the kit and watcher against it. No public network is contacted.

## Limits
- Built-in checks cover the job 2 criteria set only; other sets need entries in `CHECKS`.
- The watcher alerts; it does not send verdicts. Clock = latest block timestamp.
- Polling `getJob` per id; fine for hundreds of jobs, use an indexer beyond that.
