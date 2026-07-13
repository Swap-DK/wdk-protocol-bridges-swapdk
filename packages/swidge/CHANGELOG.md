# @swapdk/wdk-protocol-swidge-swapdk

## 1.0.0-alpha.1

### Patch Changes

- **Fix**: `quoteSwidge()` and `swidge()` now translate `SwidgeOptions.slippage` (decimal per the WDK swidge spec, `0.03` = 3%) to the basis-points integer swap-engine's `/quote` endpoint actually accepts (`300` = 3%). In 1.0.0-alpha.0 the decimal was passed through verbatim and the swap-engine rejected every quote with `400 invalid request` unless the caller explicitly omitted `slippage` (letting the server apply its own default).

  Legacy `@swapdk/wdk-protocol-bridge-swapdk-*` packages have been sending bps-integer since day one; this change aligns swidge with them. `SwapDKSwidgeOptions.slippage` and `SwapDKSwidgeConfig.defaultSlippage` remain decimals on the module's public surface.

  Regression guards in `tests/SwapDKSwidge.http.test.ts` (3 new cases) assert the outgoing request body carries `slippage: 300` (from decimal `0.03`), `slippage: 100` (from decimal `0.01`), and `slippage: 50` (from `defaultSlippage: 0.005`). Verified end-to-end against `api.swapdk.com` — quote returns 200 with a real THORChain route.

## 1.0.0-alpha.0

### Initial release

First release of the SwapDK swidge protocol module — a single-class implementation of the WDK [`ISwidgeProtocol`](https://docs.wdk.tether.io/sdk/swidge-modules/) interface covering every source-chain family the SwapDK swap-engine can route.

Contents:

- **`SwapDKSwidge`** extends `SwidgeProtocol` from `@tetherto/wdk-wallet/protocols`. Implements the five abstract methods (`quoteSwidge`, `swidge`, `getSwidgeStatus`, `getSupportedChains`, `getSupportedTokens`). The base class handles the legacy `IBridgeProtocol` / `ISwapProtocol` API for free by delegating `bridge/quoteBridge/swap/quoteSwap` to `swidge/quoteSwidge`.

- **Per-source-chain adapters** for Bitcoin, EVM, Cosmos-family, Solana, and TRON. Dispatch pattern lifted from the legacy `SwapDKBridge*` packages in this monorepo; behaviour is 1:1 within each source family. `swidge()` picks the right adapter based on the resolved `fromChain`.

- **Discovery endpoints** (`getSupportedChains` / `getSupportedTokens`) proxy the `/chains` and `/tokens?shape=swidge` endpoints added to swap-engine (server-side halt-filter + aggregation across THORChain / MAYAChain / Chainflip).

- **Public helpers**: `swapkitChainFor`, `swidgeChainFor`, `chainFamilyFor`, `nativeMetaFor`, `allSwidgeChains` (chain-map); `encodeSwapKitAsset`, `toHumanAmount`, `fromHumanAmount` (asset-encode). Adapter account interfaces (`SwidgeEvmAccount`, `SwidgeBtcAccount`, etc.) are exported from the top-level module surface for consumer typing.

- **`@tetherto/wdk-wallet` peer** is pinned to exact `1.0.0-beta.11`. Same pin the [Rhino.fi swidge module](https://www.npmjs.com/package/@rhino.fi/wdk-protocol-swidge-rhinofi) uses — upstream `1.0.0-beta.12+` regressed the `SwidgeProtocol` re-export from `/protocols/index.js`. Pin loosens once upstream restores the export.

### Known limits (tracked for v1.0.0)

- `SwidgeProtocolConfig.maxNetworkFeeBps` / `maxProtocolFeeBps` are accepted but not enforced. Fees surface on `SwidgeResult.fees` so callers can enforce client-side.
- `SwidgeOptions.minAmountOut` is accepted but not forwarded to `/quote`. Use `slippage` instead.
- Solana source: native SOL only. SPL-token path is a separate design.
- `getSupportedTokens.fromToken` filter is passed to the backend but does not currently narrow the returned list.

### Rationale

The WDK ecosystem's [swidge interface](https://docs.wdk.tether.io/sdk/swidge-modules/) is now the preferred protocol path — legacy `IBridgeProtocol` / `ISwapProtocol` modules remain supported but are soft-deprecated. This module replaces our per-source-chain family (`@swapdk/wdk-protocol-bridge-swapdk-{btc,cosmos,evm,solana,tron}`) with a unified surface. The five legacy packages continue to function; they'll receive a legacy notice in a follow-up release and eventually reach EOL when consumers have migrated.
