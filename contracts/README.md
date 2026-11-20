# contracts

The Solidity source for `AgentKoinAuthCaptureArbiterV03` and the four files it imports directly. `AgentKoinAuthCaptureArbiterV03.sol` is byte-for-byte the source verified on Sourcify for the Base Sepolia deployment. Testnet prototype; unaudited.

| field | value |
|---|---|
| contract | `src/arbiter/AgentKoinAuthCaptureArbiterV03.sol` (`VERSION() = "0.3"`, EIP-712 domain `x402 outside-verdict` / `0.3`) |
| imports | `src/arbiter/IAuthCaptureEscrow.sol`, `src/interfaces/IEvaluatorRegistry.sol`, `src/interfaces/IArbitrator.sol`, `src/PayoutScheduleLib.sol`, OpenZeppelin Contracts v5.1.0 |
| Base Sepolia (84532) | `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5` |
| Sourcify | exact_match: https://repo.sourcify.dev/84532/0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5 |
| compiler | solc 0.8.28, optimizer 200 runs, evm cancun, no via-ir |
| constructor | escrow `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` (AuthCaptureEscrow v1.1), registry `0x30576DE005df028D1947C56dEcc85a2a5612036a`, arbitrator `0x0`, token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, maxAmountPerPayment `1000000`, config `(3600, 600, 3600, 3600, 1000, 2500, 2000, 1000000)` |

## What v0.3 adds over v0.2
- `Terms.submitter` is optional. If it is zero, `info.receiver` submits, exactly as in v0.2. If it is set, only that address can `submit`. This lets `info.receiver` be a keyless address, such as a Stripe crypto deposit address, while the seller's own wallet submits.
- `submitter` is part of `TERMS_TYPEHASH` (`0x8b1eaa5ae5d3eb6c995dcc79a0cf4244003358020d8a691f033b780ae1507cd4`), so the salt the buyer signs commits to it.
- Capture still pays `info.receiver`.
- `bindTerms` rejects these role conflicts:
  - an evaluator equal to the payer, the receiver or the effective submitter (`EvaluatorConflict`)
  - an effective submitter equal to the payer (`SubmitterIsPayer`)
- A missed-verdict slash pays its harmed share to the effective submitter.

## Build
```
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge build
```
The registry, escrow and test suites are not in this repository. The TypeScript and Python helpers in `../arbiter-sdk` and `../python/agentcoin-core` mirror this contract's hashes and digests, and their vectors were checked against it.
