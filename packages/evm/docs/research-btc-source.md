# Research: BTC as a source chain

> **Status (2026-04-23):** Blocked on upstream `@tetherto/wdk-wallet-btc`.
> swap-engine side works; WDK-side OP_RETURN support is the missing
> piece. Deferred in favour of Solana source (unblocked — see roadmap).

## Goal

Build `@swapdk/wdk-protocol-bridge-swapdk-btc` so a WDK app can swap
native BTC → any destination asset supported by swap-engine (ETH, USDC
on EVM chains, TRX, LTC, DOGE, etc.). Routing would be via THORChain
(and potentially MAYAChain), mirroring the EVM source module's
architecture.

## swap-engine side — works

Live `/quote` against `dev-api.swapdk.com` with `sellAsset: "BTC.BTC"`:

```bash
curl -X POST "$DEV_URL/quote" -H "x-api-key: $DEV_KEY" -H "Content-Type: application/json" -d '{
  "sellAsset": "BTC.BTC",
  "buyAsset":  "ETH.ETH",
  "sellAmount": "0.01",
  "sourceAddress":      "bc1q…",
  "destinationAddress": "0x…",
  "slippage": 300,
  "includeTx": true
}'
```

Response shape (abridged):

```json
{
  "routes": [{
    "providers": ["THORCHAIN"],
    "sellAsset": "BTC.BTC",
    "sellAmount": "0.01",
    "buyAsset": "ETH.ETH",
    "expectedBuyAmount": "0.33324564",
    "inboundAddress":    "bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9",
    "targetAddress":     "bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9",
    "expiration":        "1776951708",
    "memo":              "=:e:0xe89E…:32324827:commission/SDK:444/5",
    "fees": [ /* inbound / liquidity / affiliate / service / outbound */ ],
    "estimatedTime": { "total": 630, "inbound": 600, "swap": 6, "outbound": 24 },
    "nextActions": [ { "method": "POST", "url": "/swap", "payload": { … } } ]
  }]
}
```

Notable differences from the EVM-source response:

- **No `tx` field.** swap-engine can't prepare a BTC deposit tx — that's
  the client's job.
- `inboundAddress` + `memo` are what the client needs. The deposit tx
  must pay `sellAmount` BTC to `inboundAddress` **and** include an
  `OP_RETURN` output carrying `memo` as raw bytes.
- `expiration` is a Unix timestamp after which the `inboundAddress`
  (a rotating THORChain vault) no longer accepts deposits for this
  quote.

### `/swap` is not useful for BTC source

`nextActions` advertises `POST /swap`, but calling it with the returned
`routeId` currently returns `502` (plain Cloudflare page, no origin
JSON). For BTC source there's nothing useful `/swap` could return —
the quote already carries the inbound vault + memo. We can safely skip
`/swap` in the client implementation.

(Aside: this is the same 5xx-body-overlay pattern we fixed for `/track`
with the [404 semantic split](../CHANGELOG.md). If BTC support matures
on the backend, we may want a similar cleanup for `/swap` on non-EVM
routes, but it isn't release-critical.)

### Memo format

`=:e:0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54:32324827:commission/SDK:444/5`

Standard THORChain swap memo:

- `=` — swap action
- `e` — short code for the destination chain (ETH)
- `0x…` — destination address (on the EVM chain in this case)
- `32324827` — minimum output in the destination asset's native
  precision (THORChain uses 1e8-style "base amounts"; the client
  doesn't need to construct this — swap-engine provides it ready to
  emit)
- `commission/SDK` — affiliate tag
- `444/5` — affiliate bps fields

Observed length: ~70 bytes, comfortably within the 80-byte OP_RETURN
policy limit enforced by Bitcoin Core since v0.12. If swap-engine ever
emits longer memos (larger addresses on some destination chain, added
affiliate params), we'll need to re-verify.

## WDK side — blocked

Inspected `@tetherto/wdk-wallet-btc@1.0.0-beta.8` (Apache-2.0, 
[tetherto/wdk-wallet-btc](https://github.com/tetherto/wdk-wallet-btc)).

### Stack (good)

- `bitcoinjs-lib@6.1.7` — industry-standard PSBT construction.
- `@mempool/electrum-client` — reads/broadcasts via Electrum.
- `@bitcoinerlab/coinselect`, `@bitcoinerlab/descriptors`,
  `@bitcoinerlab/secp256k1` — coin selection + descriptors.
- `bip32`, `bip39`, BIP-84 Native SegWit by default.
- Alternative providers: Blockbook REST, Electrum WebSocket.

### Public API (insufficient)

The only public method that constructs a spending transaction is
[`WalletAccountBtc.sendTransaction`](https://github.com/tetherto/wdk-wallet-btc/blob/main/src/wallet-account-btc.js)
(src line 205 in beta.8):

```js
async sendTransaction ({ to, value, feeRate, confirmationTarget = 1 }, timeoutMs = 10000) {
  // … planSpend, _getRawTransaction, broadcast, UTXO poll …
}
```

It accepts **a single recipient** and optional fee parameters. There is
no way to:

- Add multiple outputs.
- Add an **`OP_RETURN` output** carrying arbitrary bytes.
- Supply a pre-built PSBT to sign (no `signTransaction(psbt)`).
- Supply raw outputs or script data.

`sign(message)` is [BIP-137 message signing](https://github.com/tetherto/wdk-wallet-btc/blob/main/src/wallet-account-btc.js)
(line 187 in beta.8), not transaction signing.

The private helpers (`_getRawTransaction` at line 431, `_planSpend`,
and `_masterNode`) would be enough to bolt OP_RETURN support on, but
they're underscore-prefixed and not part of the contract.

### Why that's a hard blocker

THORChain **routes on the OP_RETURN memo**: a deposit without memo is
either refunded or treated as a donation to the pool. No OP_RETURN =
no swap, no refund address encoded. The BTC source module can't
function against the current `wdk-wallet-btc` public surface.

## Options forward

| # | Approach | Effort | Timeline | Cleanliness |
|---|---|---|---|---|
| A | **Upstream PR** to `tetherto/wdk-wallet-btc` — add an optional `memo` / `opReturn` field to `sendTransaction` (or a separate `sendRawTransaction({ outputs })`). ~100 LOC + tests. | Low | Depends on Tether review cycle | Best — benefits everyone |
| B | **Fork** as `@swapdk/wdk-wallet-btc` with OP_RETURN added. Publish under our scope. | Low (initial), ongoing maintenance | Immediate | Own our fork, risk drift from upstream |
| C | **Wrapper with raw PSBT** using private `_masterNode` / `_client` fields + bitcoinjs-lib directly. ~200 LOC. | Medium | Immediate | Poor — reaches into private API, breaks on upstream internals change |
| D | **Wait.** Open an issue on `tetherto/wdk-wallet-btc`; revisit when OP_RETURN lands. | None | Unbounded | — |

## Recommended path

**A as primary, E as hybrid fallback** — i.e.:

1. Submit a focused upstream PR adding optional `memo` to
   `sendTransaction` (or, if Tether prefers, a new
   `sendRawTransaction({ outputs })`). Respect AGENTS.md conventions
   (JSDoc types, `standard` lint, jest integration tests on `regtest`).
2. Open a tracking issue in our own repo referencing the upstream PR.
3. If the upstream PR lands quickly, use it directly.
4. If review is slow and there's real demand, temporarily fork (B) with
   a minimal diff, document the migration path back to upstream, and
   remove the fork once the PR ships.

**Explicitly rejected:** option C. Reaching into `_masterNode` and
`_client` couples our module to a private API of an upstream package
we don't own; any beta version bump could break the integration.

## Reproduction

Research snapshot:

- `@tetherto/wdk-wallet-btc@1.0.0-beta.8` (published ~2026-02).
- Key method: `src/wallet-account-btc.js` line 205 (`sendTransaction`).
- PSBT construction: `src/wallet-account-btc.js` line 431
  (`_getRawTransaction`) — shows how outputs are added; OP_RETURN
  would be a single extra `psbt.addOutput({ script: opReturnScript, value: 0 })`.
- swap-engine `/quote` for BTC source: shown above. Confirmed on
  `dev-api.swapdk.com` 2026-04-23.
- swap-engine `/swap` for BTC routeId: returned 502 Cloudflare page,
  not expected to be needed for this flow.

To re-check if / when the upstream exposes OP_RETURN:

```bash
npm pack @tetherto/wdk-wallet-btc
tar -xzf tetherto-wdk-wallet-btc-*.tgz
grep -n 'OP_RETURN\|psbt.addOutput\|opReturn\|memo' package/src/wallet-account-btc.js
```

## Related

- Solana source: supported on `@tetherto/wdk-wallet-solana`
  (`sendTransaction({ instructions })` accepts arbitrary instructions,
  so Memo Program + SystemProgram transfer compose cleanly). See
  [research-solana-source.md](./research-solana-source.md) once that
  document lands.
- `/track` and `/swap` 502-body-overlay on Cloudflare — cf. the 404
  semantic split we already shipped for `/track`. If `/swap` becomes
  relevant for non-EVM sources, a similar cleanup will help.
