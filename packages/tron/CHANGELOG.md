# @swapdk/wdk-protocol-bridge-swapdk-tron

## 0.3.0

### Major Changes

- Retire `@swapdk/wdk-wallet-tron` peer; adopt upstream `@tetherto/wdk-wallet-tron@^1.0.0-beta.8` via its new prebuilt-tx path.

  Upstream `@tetherto/wdk-wallet-tron@1.0.0-beta.8` refactored `sendTransaction` to accept a prebuilt tronweb `Transaction` (detected via `!!tx.txID`) and sign+broadcast it verbatim. That covers the raw-calldata and TransferContract-with-memo shapes the SwapDK fork carried, so the fork is no longer feature-necessary. Adopting upstream removes a maintenance burden and lets consumers install the bridge from npm without a git-source wallet package.

  **Breaking peer-dep swap.**

  ```diff
   "peerDependencies": {
  -  "@swapdk/wdk-wallet-tron": "^0.2.0",
  -  "@tetherto/wdk-wallet": "^1.0.0-beta.7"
  +  "@tetherto/wdk-wallet-tron": "^1.0.0-beta.8",
  +  "@tetherto/wdk-wallet": "^1.0.0-beta.8"
   }
  ```

  **New required config field: `tronWeb`.** The bridge now constructs the tronweb `Transaction` itself (router-contract call via `triggerSmartContract`, direct-vault deposit via `sendTrx` + `addUpdateData`) and hands the prebuilt tx to `wallet.sendTransaction`. The bridge needs the tronweb instance to do this; consumers must supply it in the config.

  ```ts
  import { TronWeb } from "tronweb";
  import { SwapDKBridgeTron } from "@swapdk/wdk-protocol-bridge-swapdk-tron";

  const tronWeb = new TronWeb({ fullHost: TRON_RPC });
  const bridge = new SwapDKBridgeTron(walletAccount, {
    apiUrl: "https://api.swapdk.com",
    apiKey: process.env.SWAPDK_API_KEY,
    tronWeb, // NEW — same instance passed to WalletManagerTron
  });
  ```

  Pass the SAME tronweb instance you gave `WalletManagerTron` — the bridge only reads from it (address encoding, `feeLimit` fallback, `transactionBuilder`), no key material is exchanged.

  **What the bridge now does internally:**

  - Router path (`SwapTx.data` non-empty): `triggerSmartContract(to, "", { feeLimit, callValue, input: data }, [], issuerHex)` builds a `TriggerSmartContract` with raw calldata as `options.input`. This is the same code path tronweb uses when `functionSelector` is empty.
  - Direct-vault path (`SwapTx.data` empty, `SwapTx.memo` set): `sendTrx(to, value, from)` builds the base `TransferContract`, then `addUpdateData(tx, memo, "utf8")` mutates `raw_data.data` AND recomputes `txID` — the memo is part of the tx hash preimage, so it MUST be attached before signing.
  - Neither `data` nor `memo`: throws `SwapDKUserError` describing an unusable `SwapTx` (previously the wallet fork threw the same message; now the bridge does).

  **Wallet interface changed.** `TronWalletAccount.sendTransaction` now takes a single `TronPrebuiltTransaction` argument (opaque `{ txID: string, ...tronwebFields }`) and returns `{ hash, fee, activationFee? }`. The old `{ to, value, data, feeLimit, memo }` shape is retired.

  **Known regressions in upstream vs. the fork** (tracked in a separate upstream issue/PR — see `docs/upstream-pr/` in the wallets monorepo):

  - No `dispose()` idempotency guard (`_disposed` flag) — a second `dispose()` call throws obscurely via double-`sodium_memzero` on already-null buffers.
  - `HDKey.wipePrivateData()` from `@scure/bip32` does NOT clear `chainCode` — 32 bytes of derivation material survives in the V8 heap. Upstream doesn't clear it explicitly.
  - `WalletManager.getAccount` / `getAccountByPath` / `getFeeRates` don't guard against post-`dispose()` calls — derivation from the zeroed seed returns a deterministic, publicly-computable key (AUDIT4-M1).

  Downstream consumers who rely on these guarantees should stay on `@swapdk/wdk-protocol-bridge-swapdk-tron@0.2.0` + `@swapdk/wdk-wallet-tron@0.2.0` until upstream lands the fixes.

  **Migration.** For each `new SwapDKBridgeTron(account, config)` call site:

  1. Install upstream: `npm i @tetherto/wdk-wallet-tron@^1.0.0-beta.8` (replaces `@swapdk/wdk-wallet-tron`).
  2. Construct a tronweb instance and pass it as `config.tronWeb` (same instance the wallet manager already uses).
  3. If your code accepted the wallet-account return shape from `sendTransaction`, update to the upstream shape (`{ hash, fee, activationFee? }` — same field names, `activationFee` is optional and typically `0n` for bridge deposits since vault addresses are always activated).

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
