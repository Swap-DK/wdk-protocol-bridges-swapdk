# @swapdk/swap-engine-client

Shared HTTP client + zod-validated wire schemas for the SwapDK [`swap-engine`](https://swapdk.com) REST API. Consumed by every SwapDK distribution channel:

- The WDK protocol bridge family in this monorepo (`@swapdk/wdk-protocol-bridge-swapdk-*`).
- The wagmi-native React library [`@swapdk/wagmidk`](https://github.com/Swap-DK/wagmidk).

> **Renamed in 0.2.0.** Previously published as `@swapdk/wdk-protocol-bridge-swapdk-common` (last version: 0.1.11). The old name was marked `"internal"`; the rename reflects that the package is now first-class shared infrastructure used by both distribution channels. See [`STATUS.md`](../../STATUS.md) (entry dated 2026-06-16) and `../../../wagmidk/docs/adr/ADR-008-swap-engine-client-rename.md` for the rationale.

## What lives here

- **`SwapDKClient`** — HTTP client for `/quote`, `/swap`, `/track`, `/chainflip/broker/channel` with timeout, exponential-backoff retry on idempotent paths, and runtime response validation via zod schemas.
- **Typed error hierarchy** — `SwapDKError` (base), `SwapDKNetworkError`, `SwapDKApiError` (with `isStaleRoute` / `isNotFound` / `isProviderUnsupported` / `isAmountBelowMin` / `isInvalidAffiliate` / `isRouteUnavailable` / `isUpstreamRejected` getters; `errorCode: "response_schema_mismatch"` + `cause: ZodError` when a response fails schema validation), `SwapDKProviderError`, `SwapDKUserError`.
- **Route selection** — `pickBestRoute()` filters zero-quote routes and returns the highest-output one.
- **Asset utilities** — `toHumanDecimal`, `fromHumanDecimal`, `parseSwapKitAsset`, `toBigInt`, the chain map (`CHAIN_MAP`), native-symbol table (`NATIVE_SYMBOL`), and native-decimals table (`NATIVE_DECIMALS`).
- **Token registry primitives** — `KnownToken` type, `lookupToken`, `registerToken`, plus the destination-side ERC-20 entries (USDC / USDT / WETH / WBTC / DAI / wrapped natives across the supported EVM chains).
- **HTTP wire schemas (zod-first)** — `QuoteRequestSchema` / `QuoteResponseSchema` / `QuoteRouteSchema`, `SwapRequestSchema` / `SwapResponseSchema`, `TrackRequestSchema` / `TrackResponseSchema` / `TrackLegSchema`, `ChainflipAssetSchema` and the broker-channel family. Types are derived via `z.infer<typeof Schema>` and exported under the same names (`QuoteRequest`, `QuoteResponse`, …).

## Response validation

Every `SwapDKClient` public method pipes the server's JSON body through `safeParse()`:

```ts
const json: unknown = await res.json();
const parsed = schema.safeParse(json);
if (!parsed.success) {
  // First failed field path is included in the error message for quick debugging.
  // Full ZodError is on err.cause for programmatic introspection.
  throw new SwapDKApiError(res.status, path, "response_schema_mismatch", `${where}: ${why}`, parsed.error);
}
return parsed.data;
```

Outgoing request bodies are **not** validated at runtime — call-sites are owned by SwapDK code and covered by TypeScript. Validating them would be gratuitous work.

## What does NOT live here

- Source-chain-specific asset mapping (e.g. EVM's `NATIVE_ADDRESS = "0x000…"` vs Solana's `""` marker, source-chain ERC-20s/SPLs).
- Wallet account interfaces (`EvmWalletAccount`, `SolanaWalletAccount`) — defined in their respective bridge packages.
- Bridge classes — `SwapDKBridgeEvm`, `SwapDKSwapEvm`, `SwapDKBridgeSolana`, etc.
- Module-specific tx-builders.
- WagmiDK-specific concerns (React hooks, wagmi/viem integration, native-token sentinel, etc.) — those live in the WagmiDK repository.

## Versioning

Independent semver via [changesets](../../.changeset/). Consumer packages depend on this with a normal semver range; bumps here cascade through changesets the next time they're released.

The `common`-published-first invariant carries forward under the new name: `@swapdk/swap-engine-client` must be published before any consuming bridge package that depends on a new version of it, or npm rejects the unresolvable range.
