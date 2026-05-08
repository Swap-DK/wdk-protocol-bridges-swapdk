# Status

Snapshot of where each package stands. Updated per milestone, not per commit — for ground-truth on a specific feature, check the package's CHANGELOG and the relevant git history.

## Packages

| Package | Source / Targets | Version | Stage | Notes |
|---|---|---|---|---|
| `@swapdk/wdk-protocol-bridge-swapdk-common` | shared infra | 0.1.2 | beta | adds `tx.gasPrice` to `QuoteRoute`/`SwapResponse` HTTP types so EVM consumers can compute real fee (gas × gasPrice). Backwards-compatible. |
| `@swapdk/wdk-protocol-bridge-swapdk-evm` | EVM source → any | 1.0.1 | stable | normalises `sendTransaction` return (string OR `{ hash }`) — `@tetherto/wdk-wallet-evm` returns the latter; previously caused `result.hash` to be `[object Object]`. Also computes `result.fee` as gas × gasPrice (proper wei) instead of gas-units alone. |
| `@swapdk/wdk-protocol-bridge-swapdk-solana` | Solana source → any | 0.1.0 | beta | unchanged this cycle |
| `@swapdk/wdk-protocol-bridge-swapdk-cosmos` | THORChain (RUNE), MAYAChain (CACAO) → any | 0.1.0 | beta | first publish; supports both `MsgDeposit` (protocol-native) and `MsgSend` (cross-protocol vault) routes |

The cosmos package depends on `@swapdk/wdk-wallet-cosmos` (sibling repo) — that package must be published to npm before cosmos goes live.

## In flight

(empty)

## Blocked

- **BTC source module** — upstream THORChain inbound observation requires `OP_RETURN` in the spending tx, but Bitcoin Core's standardness rules cap `OP_RETURN` at 80 bytes which doesn't fit a typical swap memo. See `docs/btc-source-research.md`.
- **Trade-asset deposits on THORChain / MAYAChain** — fees and decimals fall back to chain-native defaults; correct handling needs an asset-registry extension. Not on near-term roadmap.

## Recently shipped

- **2026-05-08** — Layer B mainnet regression for the EVM source stack: 0.0028 ETH → RUNE via THORChain `depositWithExpiry` on Asgard router, broadcast through `bridge.bridge()` and confirmed in `completed` state on the destination chain. Surfaced two bugs in `bridge-swapdk-evm@1.0.0` that 1.0.1 fixes: `result.hash` was returning `[object Object]` (TransactionResponse object not unpacked) and `result.fee` was gas-units instead of wei. Both shipped as additive patches.
- **2026-05-07** — Layer B mainnet regression for the cosmos source stack: 15 RUNE → LTC via THORChain MsgDeposit, broadcast through `bridge.bridge()` + tracked through `waitForBridge` to terminal `completed`. End-to-end path (wallet signing, RPC broadcast, Asgard memo parsing, pool execution, outbound, Midgard indexing) confirmed live.
- **2026-05-05** — `bridge-swapdk-common@0.1.1`: add 4 new `SwapDKApiError` getters (`isInvalidAffiliate`, `isRouteUnavailable`, `isUpstreamRejected` — mirroring swap-engine's refined errorCode classification; `isAmountBelowMin` from earlier).
- **2026-05-04** — `bridge-swapdk-cosmos@0.1.0`: dispatch to `MsgSend` for cross-protocol routes (e.g. RUNE → BTC routed via MAYAChain). Fixes a silent route-shape mismatch in the v1 scaffold.
- **2026-05-03** — `bridge-swapdk-cosmos@0.1.0`: initial scaffold, MsgDeposit-only.
- **2026-05-03** — `bridge-swapdk-common`: register THORChain and MAYAChain in chain maps (additive).

## Coordinates

- Sibling repo with the cosmos wallet: `wdk-wallets-swapdk` (`@swapdk/wdk-wallet-cosmos`).
- Backend service the bridge clients call: `swap-engine` (Go).
- WDK base classes / wallet contract: `@tetherto/wdk-wallet`.
