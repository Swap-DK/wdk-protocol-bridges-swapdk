# Changelog

All notable changes to `@swapdk/wdk-protocol-bridge-swapdk-evm` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **`SwapDKApiError.isProviderUnsupported`** — getter that's `true` only for `/swap` 422 with `swapProviderUnsupported` errorCode. Pairs with the recent swap-engine fix that splits "routeId references a provider this engine doesn't implement" out of the catch-all 502. Use it to surface "this route can't be executed, pick a different provider" cleanly without retry.
- **`registerToken(chain, address, { symbol, decimals })`** — runtime extension of the known-token registry. Use this to support ERC-20s that aren't shipped in `src/known-tokens.ts`. Validates the input synchronously (`0x` + 40 hex, non-empty symbol, decimals ∈ [0, 77]) and normalises address to lowercase, symbol to uppercase. Module-level singleton — visible to every `SwapDKBridgeEvm` / `SwapDKSwapEvm` in the process. Successful registration does not guarantee backend routability.
- **Bridge tracking API.** Wraps swap-engine's `/track` endpoint for THORChain and MAYAChain routes.
  - `SwapDKBridgeEvm.trackBridge(hash, chainId?)` — one-shot status lookup; returns `null` when the hash is not yet indexed in Midgard.
  - `SwapDKBridgeEvm.waitForBridge(hash, chainId?, opts?)` — polls `/track` until the bridge reaches a terminal state (`completed`, `refunded`, `failed`) or the timeout elapses. Supports `pollIntervalMs`, `timeoutMs`, and `onUpdate` callback for progress UIs.
  - `SwapDKClient.track({ hash, chainId })` — low-level HTTP method.
  - `SwapDKApiError.isNotFound` — `true` only for `/track` 404 `track_not_found`; distinguishes the common "hash not yet indexed" case from genuine upstream failures (502), which remain thrown.
  - New types exported: `TrackRequest`, `TrackResponse`, `TrackLeg`, `TrackMeta`, `TrackStatus`, `WaitForBridgeOptions`.
  - Note: tracking is limited to THORChain and MAYAChain on the swap-engine side. Chainflip-routed bridges return `null`.

### Changed
- `SwapDKClient` error parser now also reads the `"error"` field (used by `/track`) in addition to the existing `"errorCode"` (used by `/quote` and `/swap`). This lets `SwapDKApiError.errorCode` carry the backend's semantic code across all endpoints.
- `SwapDKApiError.isStaleRoute` is now scoped to the `/swap` path only. Previously it matched any 404/410 regardless of path, which was incorrect once `/track` also began returning 404 with different semantics.

---

## [1.0.0] — 2026-04-22

### Added
- **Known-token registry (`known-tokens.ts`)** — hardcoded map of canonical ERC-20 addresses to `{ symbol, decimals }` per supported chain (Ethereum, Arbitrum, Base, BSC, Avalanche, Optimism, Polygon). Covers USDC (incl. bridged variants), USDT, WETH/WBNB/WAVAX/WMATIC, WBTC, DAI.
- **Amount conversion primitives** (`asset-map.ts`):
  - `NATIVE_DECIMALS` table per SwapKit chain prefix
  - `getAssetDecimals(chain, address)` and `resolveAssetDecimals(chain, tokenRef)` unified decimal lookup
  - `toHumanDecimal(bigint, decimals)` / `fromHumanDecimal(string, decimals)` — precision-safe, no float math
- **Route selection helper (`route-select.ts`)** — `pickBestRoute()` filters zero-quote fallbacks and picks the route with the highest `expectedBuyAmount`. Avoids a bug where swap-engine returned a MAYACHAIN zero-quote as `routes[0]` ahead of the real CHAINFLIP quote.
- `prepack` script — production build runs automatically before `npm publish`
- `repository`, `author`, `bugs`, and `homepage` fields in `package.json`
- CI/CD pipeline: lint → test (with cobertura coverage) → smoke test → npm publish on tag
- Smoke test script (`scripts/smoke-test.js`) — verifies swap-engine connectivity
- `.env.example` template for local development credentials
- `LICENSE` (MIT), `.npmignore`, `.editorconfig`

### Changed
- **Amount-format contract at the HTTP boundary.** `SwapDKBridgeEvm` and `SwapDKSwapEvm` now convert WDK `bigint` amounts (in native decimals) to human-decimal strings before calling swap-engine's `/quote` and parse response amounts back via `fromHumanDecimal`. Previously the client sent wei-style integers and parsed responses with `toBigInt` (truncation), producing amounts that were off by `10^18` for cross-chain and in the wrong asset's decimals for same-chain.
- **ERC-20 asset notation now carries the real symbol** (`ETH.USDC-0xAddr`, not `ETH.ETH-0xAddr`). swap-engine's `ConvertToChainflipFormat` strips the `-0xAddress` suffix and routes on the symbol alone; placeholder symbols led to silent misrouting.
- `tsconfig.json`: `module` and `moduleResolution` changed from `ESNext`/`bundler` to `nodenext` — enforces correct Node.js ESM resolution semantics
- `package.json`: removed `viem` from dependencies, bumped `@tetherto/wdk-wallet` peerDep floor to `^1.0.0-beta.7`
- `package.json`: description updated to mention both bridge and swap; keywords extended with `same-chain` and `evm`
- Project layout: test files moved from `src/*.test.ts` to `tests/` to match WDK module convention
- `prepack` now runs `clean && build` so stale artifacts from removed files never ship

### Removed
- `TokenRegistry` and `/tokenlists/:chain` client method — the endpoint was never implemented in swap-engine. Symbol resolution now happens client-side via the known-token registry.
- `needsSymbolResolution()` helper, `TokenListToken`, `TokenListResponse` types
- `viem` from peerDependencies (no viem imports anywhere in the package)

### Fixed
- `toBigInt()` helper for swap-engine amounts — swap-engine returns decimal strings; `BigInt()` rejects decimals, so amounts are now truncated to integer part.
- `examples/wdk-app.ts` — fixed imports from non-existent `@tetherto/wdk-core` to real `@tetherto/wdk` and switched to importing from the package name rather than `../src`
- End-to-end amounts verified: `quoteBridge 0.01 ETH → BTC` returns `~30,581 sat` (was `3.04 × 10^14`); `quoteSwap 100 USDC → ETH` returns `~0.0416 ETH in wei` (was `~100 USDC-denominated nonsense`).

---

## [0.4.0] — Swap protocol support

### Added
- `SwapDKSwapEvm` — WDK `SwapProtocol` implementation for same-chain EVM swaps (e.g. USDC → WETH on Ethereum)
- `quoteSwap()` and `swap()` methods with full ERC-20 approval handling
- Re-quote on stale `routeId` in `swap()`, mirroring bridge behaviour
- `swapMaxFee` enforcement in `SwapDKSwapEvm`
- Both `SwapDKBridgeEvm` and `SwapDKSwapEvm` can be registered in a single WDK app
- Unit tests for `SwapDKSwapEvm` — 95%+ branch coverage

### Changed
- `SwapDKBridgeConfig` extended with `swapMaxFee` option
- `index.ts`: exports `SwapDKSwapEvm` and `SwapDKSwapResult`
- README: added same-chain swap quick start, WDK dual-registration example

---

## [0.3.0] — Production hardening

### Added
- Re-quote on stale `routeId`: if `/swap` returns 404/410 or `STALE_ROUTE`, the bridge automatically re-quotes once and retries
- `bridgeMaxFee` enforcement — throws `SwapDKUserError` before sending any transaction when estimated gas exceeds the limit
- HTTP timeout via `AbortSignal.timeout()` (default 10 s, configurable via `timeoutMs`)
- Exponential backoff retry for 5xx responses and network errors (default 2 retries, configurable via `retries`)
- Error classification: `SwapDKUserError`, `SwapDKProviderError`, `SwapDKApiError`, `SwapDKNetworkError`
- `SwapDKApiError.isStaleRoute` property for route-expiry detection

### Changed
- `SwapDKClient`: merged duplicate `get`/`post` into a single `request<T>()` method; fixed body-consumed bug (reads `text()` first, then `JSON.parse()`)
- `NATIVE_ADDRESS`, `NATIVE_SYMBOL`: consolidated in `asset-map.ts` (removed duplication)
- `defaultBuyAsset()`: uses `NATIVE_SYMBOL` map — adding a new chain to the map now covers both bridge and asset resolution automatically

---

## [0.2.0] — Testing & WDK integration

### Added
- Unit tests for `asset-map`, `SwapDKClient`, `SwapDKBridgeEvm` — 95%+ branch coverage
- `SwapDKBridgeEvm` extends `BridgeProtocol` from `@tetherto/wdk-wallet/protocols`
- SwapDK-specific types (`SwapDKBridgeOptions`, `SwapDKBridgeResult`, `SwapDKBridgeQuoteResult`) extend WDK base types
- WDK app scaffold: `examples/wdk-app.ts`

---

## [0.1.0] — Foundation

### Added
- `SwapDKBridgeEvm` with `bridge()` and `quoteBridge()`
- HTTP client for swap-engine `/quote` and `/swap` endpoints (native `fetch`, no external HTTP library)
- Asset mapping: WDK token addresses → SwapKit notation (`ETH.USDC-0xAddress`)
- ERC-20 approval handling (`approvalTx`) with optional `waitForTransaction` support
- TypeScript types for all swap-engine API request/response shapes
- Supported source chains: Ethereum, Arbitrum, Base, BSC, Avalanche, Optimism, Polygon
