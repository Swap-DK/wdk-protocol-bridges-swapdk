# Research: BTC source via Chainflip (deposit-channel flow)

> **Status (2026-05-21):** Server-side wiring exists in `swap-engine`
> for both the deposit-channel open (`POST /chainflip/broker/channel`)
> and the Chainflip fallback in `/track`. **Live confidence: unverified**
> — unit tests cover fixtures, but no end-to-end mainnet round-trip has
> been performed. Client-side (`@swapdk/wdk-protocol-bridge-swapdk-btc`)
> currently rejects Chainflip-routed BTC quotes with a clear
> `SwapDKUserError` (added in `0.1.1`); this doc describes the work to
> close that gap and turn Chainflip into a first-class second provider
> alongside THORChain on BTC source.

## Why this exists

`@swapdk/wdk-protocol-bridge-swapdk-btc@0.1.0` was scoped to THORChain
only — modelled after the inbound-vault + `OP_RETURN` memo pattern
documented in [`research-btc-source.md`](../../evm/docs/research-btc-source.md).
When THORChain halts (chain upgrade, pool drain), swap-engine falls
back to Chainflip and returns a different route shape. Our module
silently produced a degraded quote (empty `inboundAddress`/`memo`); a
broadcast attempt would have failed in `bridge()`. The 0.1.1 filter
now errors out cleanly, but the gap is real — adding Chainflip support
unblocks BTC E2E even while THORChain is down.

## Two providers, two flows

| Aspect | THORChain (already shipped) | Chainflip (gap) |
|---|---|---|
| Deposit address | Rotating Asgard vault, comes back on every `/quote` (`route.inboundAddress`) | Unique per swap, allocated by Chainflip Broker, **must be requested via `POST /chainflip/broker/channel`** |
| Memo | `OP_RETURN` carrying the THORChain swap memo from `route.memo` | None — the deposit address itself encodes the swap intent |
| Refund | Implicit (the sender on the source chain is the refund recipient) | **Explicit** — `refundParameters.refundAddress` is REQUIRED |
| TTL | `route.expiration` Unix seconds (typically ~10 min) | `sourceChainExpiryBlock` from the broker response — currently NOT exposed by swap-engine's `/chainflip/broker/channel` endpoint |
| Tracking | Midgard via hash | Chainflip v2 swap API via hash or swap ID; raw deposit address lookup is **not** supported by Chainflip's v2 endpoint (per code comment in `utils/track_swapkit.go:119`) |
| Affiliate fees | Encoded into the OP_RETURN memo | Up to 5 broker accounts via `affiliateFees[]` |
| Fee shape | `liquidity` + `outbound` (route `fees[]`) | `channel_opening_fee` (on-chain) + swap fee (off-chain) + optional `boost_fee` — none reported on `/quote`; client must learn it separately |

## swap-engine side — already wired

### `POST /chainflip/broker/channel` (lives in `Controllers/chainflip_broker_channel_controller.go`)

#### Request body (`ChainflipBrokerChannelRequest`)

```jsonc
{
  // Chainflip-native asset notation — distinct from SwapKit's "ETH.ETH" form.
  "sellAsset":          { "chain": "Bitcoin",  "asset": "BTC" },
  "buyAsset":           { "chain": "Ethereum", "asset": "ETH" },
  "destinationAddress": "0xRecipient…",       // address on buy chain

  "refundParameters": {                       // REQUIRED (Chainflip v2.0.5+)
    "refundAddress": "bc1q…",                 // on the SOURCE chain
    "minPrice":      "0x0",                   // hex; "0x0" disables price floor
    "retryDuration": 100                      // blocks; defaults to 100
  },

  "affiliateFees": [                          // optional, max 5 entries
    { "brokerAddress": "cFxxxxxxxxxx…", "feeBps": 50 }
  ],
  "dcaParameters":    { "chunkInterval": 2, "numberOfChunks": 10 },  // optional
  "channelMetadata":  { "ccmAdditionalData": "…", "gasBudget": "…", "message": "…", "cfParameters": "…" },  // optional CCM
  "maxBoostFeeBps":   30                      // optional; 0 = disabled
}
```

Server semantics (from `OpenBrokerChannel` line 141+):
- `refundParameters.refundAddress` is **strict-required**; missing or blank → `400`.
- `BROKER_COMMISSION_BPS` env supplies the broker commission; the
  client never sets it.
- Empty `affiliateFees` and `dcaParameters` are passed as `null` /
  empty array — Chainflip treats both as defaulted.

#### Response body (`ChainflipBrokerChannelResponse`)

```jsonc
{
  "depositAddress": "bc1qrandom…",                  // unique per swap
  "channelId":      "6739624-Bitcoin-2562",         // composite: <issuedBlock>-<SourceChain>-<channelId>
  "explorerUrl":    "https://scan.chainflip.io/channels/6739624-Bitcoin-2562",
  "error":          ""
}
```

**Surface gaps in the response (worth fixing server-side, but not blockers for v1):**
- `sourceChainExpiryBlock` from Chainflip is parsed into
  `brokerSwapDepositResult` but **not propagated to the client**. We
  can't enforce TTL pre-broadcast the way we do for THORChain
  (`route.expiration`). Workaround: enforce a conservative client-side
  TTL (e.g. 10 minutes from channel open) and re-quote if the
  user doesn't broadcast in time.
- `channelOpeningFee` is also dropped. Not load-bearing for v1 (the
  fee is paid by the broker, not the user), but useful to surface for
  observability later.

Env requirements (operator-side):
- `CHAINFLIP_BROKER_API_URL` — required.
- `BROKER_COMMISSION_BPS` — optional, default 0.
- `CHAINFLIP_EXPLORER_BASE_URL` — optional, default `https://scan.chainflip.io/channels`.

### `/track` Chainflip fallback (lives in `utils/track_swapkit.go` + `utils/track_chainflip.go`)

The `/track` endpoint already accepts an optional `depositAddress`
field on its request body (`Models.TrackRequest.DepositAddress`,
line 11). After Midgard misses for both THORChain and MAYAChain,
swap-engine tries Chainflip's public swap-status API:

```
GET https://chainflip-swap.chainflip.io/v2/swaps/{id}
```

Where `{id}` is one of: the BTC inbound tx hash, the swap ID, or the
composite channel ID. **Important** — per the code comment on line
119 of `track_swapkit.go`, **raw deposit addresses are NOT resolved
by Chainflip's v2 endpoint**. So passing only `depositAddress` won't
work; the client should pass the BTC tx hash as the primary
identifier and use `depositAddress` as a hint only.

`buildChainflipTrackResponse` (`utils/track_chainflip.go:103`) maps
the Chainflip payload into our `TrackResponse` shape — same shape as
the THORChain path so consumers don't need provider-aware parsing.
Notable mappings:

| Chainflip state | Our `status` |
|---|---|
| `COMPLETED` | `completed` |
| `REFUND_*` | `refunded` |
| `FAIL_*` | `failed` |
| `AWAITING_DEPOSIT` / `RECEIVING` | `not_started` |
| `DEPOSIT_RECEIVED`, `SWAP_EXECUTED`, `SENDING`, `BROADCAST_REQUESTED`, `EGRESS_SCHEDULED`, … | `swapping` |
| anything else / empty | `unknown` |

Asset normalisation: `("Bitcoin","BTC")` → `"BTC.BTC"`,
`("Ethereum","USDC")` → `"ETH.USDC-0xa0b8…eb48"` (with known contract
suffix from a curated registry in `knownChainflipContract`).

`payload` carries `depositChannelId`, `depositAddress`,
`chainflipSwapId` — useful for UI deep-links to the Chainflip
explorer.

**Confidence:** `utils/track_chainflip_test.go` (165 LOC) covers the
fixture → response shape mapping for the COMPLETED happy path and
the REFUND state. End-to-end against a live Chainflip mainnet swap is
**not** verified. Likely issues to expect on first try:
- Field-name drift on Chainflip's side (their v2 API has had breaking
  changes between releases).
- Asset-decimals mismatch if Chainflip adds a new TRC-20 we don't
  have in `quote.DecimalsForChainflipAsset`.

## Client side — gaps

### `@swapdk/swap-engine-client@0.1.2`

1. `TrackRequest` doesn't expose `depositAddress`:
   ```ts
   export interface TrackRequest {
     hash: string;
     chainId: string;
   }
   ```
   Additive fix: add `depositAddress?: string;`. Backwards-compatible.
   Bump to `0.1.3`.

2. No HTTP types for the broker-channel endpoint
   (`BrokerChannelRequest`, `BrokerChannelResponse`). Add alongside
   existing `QuoteRequest` / `SwapRequest`.

3. No client method `SwapDKClient.openBrokerChannel(req)`. Add
   alongside `quote()` / `swap()` / `track()`.

### `@swapdk/wdk-protocol-bridge-swapdk-btc@0.1.1`

1. `bridge()` is hardcoded to the THORChain shape (vault address from
   `route.inboundAddress`, memo from `route.memo`). For Chainflip we
   need a separate flow:
   - call `client.openBrokerChannel(...)` to get a fresh
     `depositAddress`
   - send plain BTC tx to `depositAddress` (no memo)
   - store `depositAddress` and `channelId` on the result so tracking
     can use them

2. `trackBridge()` doesn't accept/pass `depositAddress`. Extend to
   `trackBridge(hash, chainId?, opts?: { depositAddress?: string })`
   and forward to the client.

3. `waitForBridge()` needs to remember the deposit address between
   polls (otherwise every poll loses it and Chainflip lookup degrades
   to hash-only — which works for confirmed deposits but loses the
   "channel created, not yet funded" signal).

4. The 0.1.1 Chainflip-route filter should be **removed** once the
   above lands — at that point both providers are first-class.

### `SwapDKBridgeOptions` extensions

Chainflip requires fields THORChain doesn't:

| Field | Default | Notes |
|---|---|---|
| `refundAddress?: string` | source address (`account.getAddress()`) | The user's own BTC address. Safe default unless caller wants a different refund destination. |
| `refundMinPrice?: string` | `"0x0"` | Price floor as hex (Chainflip-specific encoding). Disabled by default. Power-user setting. |
| `refundRetryDuration?: number` | `100` | Blocks the broker will retry the refund tx before giving up. |
| `dcaChunks?: number` | `1` (no DCA) | Stay simple; Chainflip's DCA is opt-in. |
| `dcaChunkInterval?: number` | `2` (only when chunks > 1) | Per Chainflip docs. |
| `maxBoostFeeBps?: number` | `0` (disabled) | Faster confirmation in exchange for a bps fee paid out of the deposit. |

None of these break the THORChain flow — they're only consulted when
the chosen route is Chainflip.

## Design choices

### Provider dispatch

Inside `bridge()`, branch on `route.providers[0]`:
- `THORCHAIN` / `MAYACHAIN` → current path (inbound + memo)
- `CHAINFLIP` → broker-channel path

Both paths return the same `SwapDKBridgeResult` shape with an
extension: when Chainflip, include `depositAddress` and `channelId`
in the result so the caller can persist them for tracking.

### Refund address default

`account.getAddress()` — the same BIP-84 native-SegWit address the
deposit is being sent from. Reuses an address the user already
controls; no extra UX. Caller can override via
`options.refundAddress` if they want refunds to a different wallet
(e.g. a cold storage address).

### TTL enforcement

Until swap-engine surfaces `sourceChainExpiryBlock`, we enforce a
conservative client-side TTL: the channel must be funded within
**10 minutes** of opening. Past that, re-quote and re-open. This
matches THORChain's default expiry window — same UX in both paths.

### Tracking strategy

`trackBridge(hash)` is the primary identifier. For
"channel created but not yet funded" — where we don't have a BTC hash
yet — `waitForBridge` keeps polling but distinguishes "Midgard miss"
(transient) from "Chainflip miss with depositAddress already shown to
the user but no deposit observed" (operational issue, surface to user
after a configurable grace).

## Recommended path

1. **`common@0.1.3`** — add `depositAddress?: string` to
   `TrackRequest`. Add `BrokerChannelRequest` / `BrokerChannelResponse`
   types. Add `SwapDKClient.openBrokerChannel(req)` method. ~30 LOC +
   types tests.
2. **`bridge-btc@0.2.0`** — dispatch by provider, Chainflip branch
   with `openBrokerChannel` + plain `sendTransaction`, optional
   refund/DCA/boost fields on `SwapDKBridgeOptions`, extended
   `trackBridge`/`waitForBridge` signatures. Remove the 0.1.1 filter
   (replaced by dispatch). ~200 LOC + new tests against mocked broker
   and mocked Chainflip swap API.
3. **E2E**: try a small BTC → ETH swap via the example CLI while
   THORChain is still halted. This **simultaneously** validates the
   open-channel flow, the broadcast, and the `/track` Chainflip
   fallback. Time-box to a couple of attempts; if the live Chainflip
   API returns unexpected shapes, fix forward on the
   `utils/track_chainflip.go` side (server) without blocking the
   client release.
4. **Server-side follow-up** (separate PR, not on this critical
   path): surface `sourceChainExpiryBlock` and `channelOpeningFee`
   from the broker result, fix the stale "for NEAR Intents" comment
   on `Models.TrackRequest.DepositAddress`.

## Reproduction

Research snapshot:
- swap-engine commit base: `dev` HEAD at 2026-05-21 (TRON dispatch
  landed in `fc0721e` / `834d417`).
- Files: `Controllers/chainflip_broker_channel_controller.go`,
  `Controllers/track_controller.go`, `utils/track_swapkit.go`,
  `utils/track_chainflip.go`, `utils/track_chainflip_test.go`,
  `Models/track.go`.
- Chainflip public docs:
  - Broker API: [chainflip-broker-api](https://docs.chainflip.io/swapping/integrations/running-a-broker/broker-api)
  - Swap status API: [v2/swaps endpoint](https://docs.chainflip.io/swapping/integrations/swap-status-api)

To re-probe live (once we wire it):
```bash
# Open a Chainflip BTC → ETH deposit channel
curl -X POST "$DEV_URL/chainflip/broker/channel" -H "x-api-key: $DEV_KEY" -H 'Content-Type: application/json' -d '{
  "sellAsset":          { "chain": "Bitcoin",  "asset": "BTC" },
  "buyAsset":           { "chain": "Ethereum", "asset": "ETH" },
  "destinationAddress": "0xRecipient…",
  "refundParameters": {
    "refundAddress": "bc1q…",
    "minPrice":      "0x0",
    "retryDuration": 100
  }
}'
```

## Related

- THORChain BTC source research:
  [`research-btc-source.md`](../../evm/docs/research-btc-source.md) —
  why we started with THORChain and what's blocked upstream on the
  wallet side (now resolved via the fork).
- TRON source research:
  [`research-tron-source.md`](../../evm/docs/research-tron-source.md)
  — the two-layer blocker pattern (swap-engine dispatch + wallet
  contract-call) that informed how we split work between the engine
  and the wallet.
