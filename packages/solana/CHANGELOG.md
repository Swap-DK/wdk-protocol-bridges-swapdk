# Changelog

All notable changes to `@swapdk/wdk-protocol-bridge-swapdk-solana` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **`SwapDKApiError.isProviderUnsupported`** — getter that's `true` only for `/swap` 422 with `swapProviderUnsupported` errorCode. Mirrors the same addition in the EVM module. Once we wire SPL-source through, callers can branch on `isProviderUnsupported` to gracefully explain "Chainflip-routed pairs aren't executable yet from non-EVM sources" without retry.

### Changed
- **`quoteBridge` now returns a meaningful `fee`.** `SOLANA_BASE_FEE_LAMPORTS` (5 000) is exported and used as the constant pre-broadcast estimate for our 1-signature, no-priority-fee transaction shape. Was `0n` placeholder.
- **`bridgeMaxFee` is now enforced pre-broadcast** in `bridge()`, against the same constant — same UX as the EVM module's pre-broadcast cap. Previously the check ran after `sendTransaction` returned, which was too late: the tx had already been mined and the user had already paid. The post-broadcast double-check is removed; the actual paid fee is still surfaced on `BridgeResult.fee` for accounting.

### Notes
- A dynamic `getFeeForMessage` RPC simulator was considered and rejected: Solana's base fee for our tx shape is deterministic, so a constant gives identical results without an extra RPC dependency. If a future tx-builder variant adds priority fees, this constant — and the comment around it — is the single point to revisit.

---

## [0.1.0] — 2026-04-23

Initial scaffold.

### Added
- `SwapDKBridgeSolana` — WDK `BridgeProtocol` implementation for native SOL as source. Bridges to any destination chain swap-engine supports (THORChain / MAYAChain routes).
- `SwapDKClient.track()` + `trackBridge()` + `waitForBridge()` — same tracking API shape as the EVM module, scoped to SOL as the default chainId.
- `buildNativeTransferWithMemo()` — helper that composes a v0 Solana `TransactionMessage` with a `SystemProgram` transfer instruction and a Memo Program instruction in one call. Designed to be passed straight into `@tetherto/wdk-wallet-solana`'s `sendTransaction`, which fills in blockhash + fee payer.
- Human-decimal amount conversion at the swap-engine HTTP boundary (lamports ↔ `"1"`, SPL base units ↔ human) — same pattern as the EVM module.
- Known-token registry seeded with USDC / USDT / wSOL on Solana plus the destination-side ERC-20s (USDC / USDT / WETH / WBTC / DAI / wrapped natives) so `tokenOut` on any supported chain resolves without extra lookups.
- `registerToken()` — runtime extension of the known-token registry; accepts both Solana base58 mints and EVM 0x-addresses, validates format.
- `pickBestRoute()` — filter zero-quote routes and select the highest-output one (same client-side fix as the EVM module).
- Typed error hierarchy: `SwapDKUserError`, `SwapDKProviderError`, `SwapDKApiError` (with `isStaleRoute` / `isNotFound`), `SwapDKNetworkError`.

### Notes / Limitations
- SPL-source bridges are not yet supported — `bridge()` rejects any non-empty `token` with `SwapDKUserError`. Enabling this needs a `buildSPLTransferWithMemo` sibling of the current tx-builder.
- Tracking is limited to THORChain and MAYAChain routes (swap-engine-side limitation).
- `quoteBridge()` returns `fee: 0n` — swap-engine doesn't pre-estimate Solana tx fees. Real fee is available on `bridge()`'s return value.

### Verified
- 100 unit tests passing; lint clean.
- End-to-end verified against `dev-api.swapdk.com`:
  - `quoteBridge 1 SOL → ETH.ETH` returns `0.0368 ETH` in wei, with a valid `inboundAddress` and THORChain-formatted `memo`.
  - `bridge()` constructs a two-instruction tx (SystemProgram transfer + Memo Program) whose `memo` bytes match what swap-engine returned.
  - `trackBridge(bogusHash)` returns `null` through the `isNotFound` path.
