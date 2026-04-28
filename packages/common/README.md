# @swapdk/wdk-protocol-bridge-swapdk-common

Shared infrastructure for the SwapDK WDK protocol bridge family. Not intended to be consumed directly — bridge-specific packages (`@swapdk/wdk-protocol-bridge-swapdk-evm`, `-solana`, …) depend on this and re-export what their users need.

## What lives here

- **`SwapDKClient`** — HTTP client for swap-engine's REST API (`/quote`, `/swap`, `/track`) with timeout + exponential-backoff retry.
- **Typed error hierarchy** — `SwapDKError`, `SwapDKNetworkError`, `SwapDKApiError` (with `isStaleRoute` / `isNotFound` / `isProviderUnsupported` getters), `SwapDKProviderError`, `SwapDKUserError`.
- **Route selection** — `pickBestRoute()` filters zero-quote routes and returns the highest-output one.
- **Asset utilities** — `toHumanDecimal`, `fromHumanDecimal`, `parseSwapKitAsset`, `toBigInt` and the destination-side native decimals table.
- **Token registry primitives** — `KnownToken` type, `lookupToken`, `registerToken`, plus the destination-side ERC-20 entries (USDC / USDT / WETH / WBTC / DAI / wrapped natives across the supported EVM chains).
- **HTTP types** — `QuoteRequest` / `QuoteResponse` / `QuoteRoute`, `TrackRequest` / `TrackResponse` / `TrackLeg` / `TrackMeta` / `TrackStatus`, `SwapRequest` / `SwapResponse`.

## What does NOT live here

- Source-chain-specific asset mapping (e.g. EVM's `NATIVE_ADDRESS = "0x000…"` vs Solana's `""` marker, source-chain ERC-20s/SPLs).
- Wallet account interfaces (`EvmWalletAccount`, `SolanaWalletAccount`) — defined in their respective packages.
- Bridge classes — `SwapDKBridgeEvm`, `SwapDKBridgeSwapEvm`, `SwapDKBridgeSolana`.
- Module-specific tx-builders.

## Versioning

Independent semver via [changesets](../../.changeset/). Bridge-specific packages depend on this with a normal semver range; bumps here cascade through changesets the next time they're released.
