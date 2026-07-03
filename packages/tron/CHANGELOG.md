# @swapdk/wdk-protocol-bridge-swapdk-tron

## 0.2.0

### Minor Changes

- ec4264f: Direct-vault deposit dispatch for TRON when THORChain's router contract is missing from `inbound_addresses`.

  `SwapDKBridgeTron.bridge()` now recognises the new `SwapTx` shape emitted by swap-engine when `inb.Router` is empty for a native TRX sell: `data: ""`, `memo: <THORChain routing instruction>`, `to: <inbound vault base58>`. The bridge module passes `tx.memo` through to `wallet.sendTransaction({ to, value, data, feeLimit, memo })` verbatim; the wallet's `_buildTronTransaction` dispatches on which of `{data, memo}` is set — contract call vs. `TransferContract` with memo embedded in `raw_data.data`.

  The router-based path (TRC-20 + native TRX when router IS deployed) is unchanged. TRC-20 sells with no router available still surface as `swap_route_unavailable` upstream — direct-vault only encodes the native asset (TRC-20 transfers require the router's `depositWithExpiry` calldata to carry the asset reference).

  **Peer-dep upgrade.** `@swapdk/wdk-wallet-tron` peer range moves from `^0.1.0` to `^0.2.0`. An older wallet without memo support would silently drop the field and send a plain `TransferContract` without routing — losing the funds to an untracked vault deposit. Hard-pinning to `^0.2.0` makes the mismatch a compile-time / install-time error rather than a runtime funds-loss.

  **Behavioural change to watch for:** end-to-end tests that mocked the swap-engine `/swap` response now need to accept both shapes (router-based and direct-vault). See `packages/tron/tests/SwapDKBridgeTron.test.ts` for the new `makeSwapResponseTrxDirectVault` fixture and the `"bridge — native TRX, direct-vault path"` describe block.

  **Rationale.** THORChain mid-2026 lifted the TRON `chain_trading_paused` flag without redeploying the router contract; native TRX inbound still works via a plain `TransferContract` to the vault with the memo carried in `raw_data.data` (the TVM equivalent of Bitcoin's OP_RETURN pattern). Verified end-to-end on mainnet on 2026-07-03: 20 TRX → 0.00382797 ETH (TRON tx `f80d4b2b8788b026ef294dfd1bc287ee1dc1e48b7af6466046e299f4c10e2ab8` → ETH outbound `2af64ace8f76615f081de3b7d8466222ea6330d57568eaa8c166d6a016bbe797`).

- Updated dependencies [ec4264f]
  - @swapdk/swap-engine-client@0.2.1

## 0.1.1

### Patch Changes

- e82db4d: Rename `@swapdk/wdk-protocol-bridge-swapdk-common` → `@swapdk/swap-engine-client`; add zod-validated response parsing.

  **Two coordinated changes:**

  1. **Rename.** The shared infrastructure package drops the `wdk-protocol-bridge-swapdk-` prefix to reflect that it is now consumed by both SwapDK distribution channels (WDK protocol bridges in this monorepo, plus the wagmi-native `@swapdk/wagmidk`). The `"internal"` keyword and the "Not intended to be consumed directly" framing are removed. All five bridge packages cascade-update their `dependencies` to the new name; public re-export shape is unchanged (`SwapDKClient`, `KnownToken`, error classes, etc. continue to be available through each bridge's package).

  2. **zod validation at the HTTP boundary.** `http-types.ts` is rewritten as `http-schemas.ts` — zod schemas are the source of truth, TypeScript types derived via `z.infer<typeof Schema>` and exported under the same names. `SwapDKClient` calls `.safeParse()` on every `/quote`, `/swap`, `/track`, and `/chainflip/broker/channel` response and throws `SwapDKApiError(errorCode: "response_schema_mismatch", cause: ZodError)` on shape mismatch, with the first failed field path included in the error message. Bridge packages inherit this validation transitively without code changes.

  **Rationale.** Lives in the WagmiDK repository (adr-kit not adopted here): `../wagmidk/docs/adr/ADR-008-swap-engine-client-rename.md` and `../wagmidk/docs/adr/ADR-009-zod-http-validation.md`. Cross-cutting cycle entry in this repo's `STATUS.md` (2026-06-16).

  **Behavioural change to watch for:** edge cases where swap-engine previously returned malformed responses that the `as`-cast tolerated will now throw `SwapDKApiError` at the boundary. Strictly an improvement (loud failure beats silent corruption); operators should monitor for `response_schema_mismatch` errorCodes on first deploy and report any genuine swap-engine shape drift back to the swap-engine team.

- Updated dependencies [e82db4d]
  - @swapdk/swap-engine-client@0.2.0
