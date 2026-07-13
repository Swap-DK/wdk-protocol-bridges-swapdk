# @swapdk/swap-engine-client

## 0.3.0

### Minor Changes

- `SwapDKClient.getSwidgeChains()` — new. GET `/chains`, returns the swidge-native `SwidgeSupportedChain[]` aggregated across THORChain / MAYAChain / Chainflip.

- `SwapDKClient.getSwidgeTokens(opts?)` — new. GET `/tokens?shape=swidge[&fromChain=X][&fromToken=Y][&toChain=Z]`, returns `SwidgeSupportedToken[]`. Chain-qualified `{ token, chain, symbol, decimals, address?, name? }` shape; the legacy SwapKit-shaped `/tokens` (without `?shape=swidge`) is unchanged and remains the default.

- Response schemas + type aliases: `SwidgeSupportedChainSchema` / `SwidgeSupportedChain`, `SwidgeSupportedTokenSchema` / `SwidgeSupportedToken`, `SwidgeChainsResponseSchema` / `SwidgeChainsResponse`, `SwidgeTokensResponseSchema` / `SwidgeTokensResponse`, `SwidgeTokensQuery`. Re-exported from the package index so downstream swidge modules (see `@swapdk/wdk-protocol-swidge-swapdk`) can validate their own callers with the same schemas.

- Private `get<T>()` helper added to `SwapDKClient` for GET-shaped endpoints. `post<T>()` and the retry / zod-parse plumbing are unchanged.

Additive across the board — no existing consumer is affected. The new endpoints are only hit when downstream calls `getSwidgeChains()` / `getSwidgeTokens()` explicitly.

**Rationale.** Adding these methods on the shared client (rather than reimplementing HTTP in the swidge module) keeps every SwapDK distribution channel — the WDK protocol bridges here plus WagmiDK — on the same wire contract and gets zod validation of the discovery responses for free.

## 0.2.1

### Patch Changes

- ec4264f: Add optional `memo` field to `SwapTx` schema for the TRON direct-vault deposit path.

  When THORChain has the TRON pool unhalted for trading but the router contract isn't deployed (transitional state observed mid-2026), swap-engine's TRON dispatch emits a `SwapTx` with `data: ""` and `memo` populated with the routing instruction. Downstream wallets embed this string into the TransferContract's `raw_data.data` field — the TVM equivalent of a Bitcoin OP_RETURN memo. The router-based path (contract call with `data` populated) is unchanged and remains the preferred flow when the router is available.

  **Additive change.** The `memo` field is `z.string().optional()`; existing consumers that don't inspect it are unaffected. EVM, Cosmos, and TRON-router SwapTx payloads continue to leave the field empty.

  **Rationale.** Cross-cutting entry in this repo's `STATUS.md` (2026-06-24) documents the direct-vault fallback design; the server-side dispatch lives in swap-engine commit `f06e3d5`.

## 0.2.0

### Minor Changes

- e82db4d: Rename `@swapdk/wdk-protocol-bridge-swapdk-common` → `@swapdk/swap-engine-client`; add zod-validated response parsing.

  **Two coordinated changes:**

  1. **Rename.** The shared infrastructure package drops the `wdk-protocol-bridge-swapdk-` prefix to reflect that it is now consumed by both SwapDK distribution channels (WDK protocol bridges in this monorepo, plus the wagmi-native `@swapdk/wagmidk`). The `"internal"` keyword and the "Not intended to be consumed directly" framing are removed. All five bridge packages cascade-update their `dependencies` to the new name; public re-export shape is unchanged (`SwapDKClient`, `KnownToken`, error classes, etc. continue to be available through each bridge's package).

  2. **zod validation at the HTTP boundary.** `http-types.ts` is rewritten as `http-schemas.ts` — zod schemas are the source of truth, TypeScript types derived via `z.infer<typeof Schema>` and exported under the same names. `SwapDKClient` calls `.safeParse()` on every `/quote`, `/swap`, `/track`, and `/chainflip/broker/channel` response and throws `SwapDKApiError(errorCode: "response_schema_mismatch", cause: ZodError)` on shape mismatch, with the first failed field path included in the error message. Bridge packages inherit this validation transitively without code changes.

  **Rationale.** Lives in the WagmiDK repository (adr-kit not adopted here): `../wagmidk/docs/adr/ADR-008-swap-engine-client-rename.md` and `../wagmidk/docs/adr/ADR-009-zod-http-validation.md`. Cross-cutting cycle entry in this repo's `STATUS.md` (2026-06-16).

  **Behavioural change to watch for:** edge cases where swap-engine previously returned malformed responses that the `as`-cast tolerated will now throw `SwapDKApiError` at the boundary. Strictly an improvement (loud failure beats silent corruption); operators should monitor for `response_schema_mismatch` errorCodes on first deploy and report any genuine swap-engine shape drift back to the swap-engine team.
