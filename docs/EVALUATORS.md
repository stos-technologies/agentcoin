# AgentKoin evaluators (Base Sepolia testnet)

Scope: Base Sepolia (eip155:84532), Circle test USDC (6 decimals, no value). Machine-readable version of these steps: `GET /v1/evaluators/onboarding`.

| Item | Value |
|---|---|
| EvaluatorRegistry | `0x30576DE005df028D1947C56dEcc85a2a5612036a` |
| Token | test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| minStake | `registry.minStake()` (2000000 = 2 test USDC at block 60881964) |
| Listing | `GET /v1/evaluators` (`list` = active, selectable per job; `all` = every staker with status) |
| Profile | `POST /v1/evaluators/profile` |
| Canary request | `POST /v1/evaluators/canary` |

## 1. Stake
Two calls from the evaluator address:

    USDC.approve(0x30576DE005df028D1947C56dEcc85a2a5612036a, minStake)
    EvaluatorRegistry.stake(minStake)

`stake(amount)` adds to the current stake; the resulting stake must be `>= minStake` (else `BelowMinStake`). Not callable while unbonding (`AlreadyUnbonding`). `isActive(address)` = `stake >= minStake && unbondingEndsAt == 0`. Active stakers appear in `GET /v1/evaluators` `list` and can be chosen per job with `?evaluator=<address>` on `/v1/notarize`.

## 2. Signed profile
Body (`agentkoin-evaluator-profile/v1`):

| Field | Rule |
|---|---|
| `type` | `"agentkoin-evaluator-profile/v1"` |
| `chainId` | `84532` |
| `registry` | registry address above |
| `address` | evaluator address (the signer) |
| `name` | 1-64 chars |
| `url` | optional, https, <= 300 chars |
| `contact` | optional, free text <= 200 chars, published as given; no email or other personal data is required |
| `verdictEndpoint` | optional, https, <= 300 chars |
| `criteriaKinds` | optional, <= 16 strings matching `^[a-z0-9][a-z0-9._-]{0,39}$` |
| `issuedAt` | unix seconds; rejected if older than 600 s or more than 120 s ahead of the server clock |
| `signature` | EIP-191 `personal_sign` over the 32 raw bytes of `keccak256(JCS(body without signature))` (RFC 8785) |

Eligibility: status `active` or `below_min_stake`. Never-staked and `unstaked` addresses: 403. A stored profile is replaced only by a newer `issuedAt` signed by the same address (older or equal `issuedAt`: 409).

Responses: `201 {result: "stored", address, digest, profile}`, `200 {result: "replaced", ...}`, `400` (field), `401` (signature or `issuedAt`), `403` (eligibility), `409` (`issuedAt` not newer), `429` (per-IP hourly cap).

judge-kit:

    cd judge-kit && npm install
    node src/profile.ts --key ./my.key --name my-judge --url https://judge.example --criteria-kinds http-200,body-sha256 --dry-run
    node src/profile.ts --key ./my.key --name my-judge --url https://judge.example

`--dry-run` prints `{event, action: "dry-run", endpoint, digest, payload}` and sends nothing. Without it the payload is POSTed to `--service` (default `https://agentcoinhq.com`). The key file is read locally and never printed.

## 3. Run the judge-kit watcher
`judge-kit/src/watch.ts` (read-only): per `Submitted` job, `deadline = submittedAt + evalWindow`, alerts at thresholds (default 1800, 600, 120 s), and evaluator health (`isActive`, stake vs `minStake`, native balance for gas). `judge-kit/src/judge.ts` computes and (with `--send`) submits `verdictScheduled`. See `judge-kit/README.md`.

    node src/watch.ts --evaluator 0xYOU --loop --interval 30

## 4. Canary job request
Body (`agentkoin-canary-request/v1`): `type`, `chainId`, `registry`, `address`, `issuedAt`, `signature` (same signing rule as the profile). Eligibility: status `active`.

The endpoint writes one queue entry and returns `202 {result: "queued", mode: "queue-only", request: {id, address, amount: "100000", ...}, onchain: null}`; a second request while one is queued returns `200 {result: "already_queued"}`. No transaction is sent by the service. The 0.1 test-USDC job (`JobEscrow.createAndFund(provider, evaluator, 100000, deadline, specHash)`) is created by the operator script `agent/scripts/run-canary.mjs --live` (service-side, not in this repository), run per batch with `CONFIRM_BATCH=<batchHash>`; the queue entry is then updated to `funded` (with tx hashes), `skipped` or `failed`.

## 5. First real job
Buyers select an evaluator per job with `?evaluator=<address>` on `/v1/notarize` (the address is part of the exact payTo route and of the escrow job). Track record: `GET /v1/evaluators/<address>`.

## Missed verdict and slashing
- No verdict within `evalWindow` after submission: anyone may call `JobEscrow.timeoutRelease(jobId)`. The client is refunded and the evaluator is slashed `slashBase * missedVerdictSlashBps / 10000`, where `slashBase` = `registry.minStake()` pinned when the job was funded (default `missedVerdictSlashBps` = 1000, i.e. 10%). The live value is in `JobEscrow.currentConfig()`.
- An overturned verdict (when an arbitrator is configured) slashes `slashBase * wrongVerdictSlashBps / 10000`.
- A slash that takes stake below `minStake` sets `isActive = false`: the address leaves `list` and appears in `all` with `status: "below_min_stake"`.

## Top up
`below_min_stake` rows in `GET /v1/evaluators` `all[]` carry `topUp`:

    {"amount": "<shortfall>", "possible": true, "registry": "0x3057...", "token": "0x036C...",
     "calls": [{"to": "<token>", "function": "approve(address,uint256)", "args": ["<registry>", "<shortfall>"]},
               {"to": "<registry>", "function": "stake(uint256)", "args": ["<shortfall>"]}]}

While unbonding, `stake` reverts; `topUp.possible` is then `false`.

## Leaving
`requestUnstake()` starts the unbonding period (`registry.config().unbondingPeriod`); `withdraw()` after it ends, with no open jobs (`HasOpenJobs`). The address then lists as `unstaked`.

## Listing row (`GET /v1/evaluators` -> `all[]`)
`address, status (active | below_min_stake | unstaked), role, label, operator, stake, minStake, shortfall, slashedTotal, unbondingEndsAt, openJobs, stakeTx, stakedAt (ISO 8601 UTC, block time of the latest Staked event), stakeBlock, profile (null or the signed profile), trackRecordUrl`, plus `topUp` for `below_min_stake` and `nextSteps` (sign profile, run judge-kit watcher, request canary job) when no profile is stored. Stakers are indexed from `Staked` events since block 59182000 (earlier: the reference evaluator, always listed).
