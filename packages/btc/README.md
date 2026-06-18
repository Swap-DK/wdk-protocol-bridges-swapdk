# @swapdk/wdk-protocol-bridge-swapdk-btc

WDK bridge protocol module for cross-chain swaps from **Bitcoin** as source. Pairs with [`@swapdk/wdk-wallet-btc`](https://www.npmjs.com/package/@swapdk/wdk-wallet-btc) (a fork of `@tetherto/wdk-wallet-btc` that adds OP_RETURN memo support) to route BTC → any destination supported by THORChain, MAYAChain, or Chainflip via the SwapDK swap-engine.

## How it works

```
WDK App
  └── SwapDKBridgeBtc(btcAccount, config)
        ├── quoteBridge() → POST /quote
        └── bridge()      → POST /quote
                            ├── THORChain/MAYAChain →                       sendTransaction({ to: inboundVault,    value, memo })
                            │                                                  └── PSBT: recipient + change + OP_RETURN(memo)
                            └── Chainflip          → POST /chainflip/broker/channel → sendTransaction({ to: depositAddress, value })
                                                                                       └── PSBT: recipient + change  (no OP_RETURN)
```

Two provider flows are supported, dispatched by `route.providers`:

- **THORChain / MAYAChain** — the inbound vault and swap memo come back on `/quote`; deposit tx pays the rotating Asgard vault with the memo as an OP_RETURN output. The wallet builds the PSBT locally.
- **Chainflip** — `/quote` carries the route metadata but **not** the deposit address. A unique deposit channel is allocated at `bridge()` time via `/chainflip/broker/channel`; the deposit is a plain BTC transfer (no OP_RETURN).

Choice is made by `pickBestRoute()` — whichever provider quotes a higher `expectedBuyAmount` for the pair wins.

Both paths:
- **Skip `/swap`.** It returns 502 for BTC source today and isn't needed (THORChain has memo+vault on `/quote`; Chainflip has the broker-channel endpoint).
- **No approval tx.** Native BTC, no token allowances.
- **Surface `fee` as the BTC source-tx fee (satoshis)** as reported by the wallet after broadcast.

## Install

```bash
npm install @swapdk/wdk-protocol-bridge-swapdk-btc \
            @swapdk/wdk-wallet-btc \
            @tetherto/wdk-wallet
```

## Usage

```ts
import WalletManagerBtc from '@swapdk/wdk-wallet-btc'
import { SwapDKBridgeBtc } from '@swapdk/wdk-protocol-bridge-swapdk-btc'

const wallet = new WalletManagerBtc({ seed: 'abandon abandon ...', /* … */ })
const account = await wallet.getAccount(0)

const bridge = new SwapDKBridgeBtc(account, {
  apiUrl: 'https://api.swapdk.com',
  apiKey: process.env.SWAPDK_API_KEY!,
  slippageBps: 300,           // 3 %
  feeRate: 10,                // sats/vB; omit for auto-estimate
})
bridge.setSourceChain('bitcoin')

// Quote (free, doesn't broadcast). For THORChain the inboundAddress +
// memo come back; for Chainflip they're undefined — the channel is
// allocated only at bridge() time so previewing doesn't consume one.
const quote = await bridge.quoteBridge({
  amount: 1_000_000n,           // 0.01 BTC, satoshis
  targetChain: 'ethereum',
  tokenOut: 'ETH.ETH',
  recipient: '0xRecipient…',
})

// Execute — provider dispatch happens inside bridge() based on the
// quoted route.
const result = await bridge.bridge({
  amount: 1_000_000n,
  targetChain: 'ethereum',
  tokenOut: 'ETH.ETH',
  recipient: '0xRecipient…',
})
// {
//   hash:           '<btc-txid>',
//   fee:            <sats>,
//   bridgeFee:      <sats>,
//   tokenInAmount:  1_000_000n,
//   tokenOutAmount: <wei>,
//   provider:       'THORCHAIN' | 'MAYACHAIN' | 'CHAINFLIP',
//   depositAddress: '<bc1q…>'    // Chainflip only
//   channelId:      '6739624-Bitcoin-2562'  // Chainflip only
// }

// Track — pass the BTC hash as the primary identifier; on Chainflip
// routes also pass depositAddress so /track can fall back to it while
// the tx is still in the mempool.
await bridge.waitForBridge(result.hash, undefined, {
  pollIntervalMs: 15_000,
  timeoutMs: 900_000,
  depositAddress: result.depositAddress,   // ignored if undefined
  onUpdate: (s) => console.log(s.status),
})
```

## Configuration

| Field          | Type                | Default              | Notes |
|----------------|---------------------|----------------------|-------|
| `apiUrl`       | string              | —                    | swap-engine base URL |
| `apiKey`       | string              | —                    | sent as `x-api-key` |
| `slippageBps`  | number              | `300`                | basis points (300 = 3%) |
| `bridgeMaxFee` | bigint              | none                 | sats — throws if liquidity fee exceeds the cap. Enforced on **both** providers. |
| `feeRate`      | number / bigint     | wallet auto-estimate | sats/vB passed to `sendTransaction` |
| `timeoutMs`    | number              | `10_000`             | HTTP request timeout |
| `retries`      | number              | `2`                  | retries on network errors / 5xx |

## Chainflip-only bridge options

Available on `SwapDKBridgeOptions` and consulted only when the chosen route is Chainflip:

| Field                  | Type    | Default                       | Notes |
|------------------------|---------|-------------------------------|-------|
| `refundAddress`        | string  | sender's BTC address          | Where the broker refunds if the swap fails. Must be on the source chain (BTC). |
| `refundMinPrice`       | string  | `"0x0"`                       | Price floor hex; disabled by default. |
| `refundRetryDuration`  | number  | `100`                         | Blocks the broker retries the refund before giving up. |
| `dcaChunks`            | number  | `1` (no DCA)                  | Split the swap into N chunks. Requires `dcaChunkInterval` when > 1. |
| `dcaChunkInterval`     | number  | —                             | Blocks between DCA chunks. |
| `maxBoostFeeBps`       | number  | `0` (boost disabled)          | Faster confirmation in exchange for a bps fee paid out of the deposit. |

These fields are silently ignored on THORChain / MAYAChain routes.

## Caveats

- **Chainflip channel TTL is not surfaced.** swap-engine parses `sourceChainExpiryBlock` from the broker response but doesn't (yet) propagate it to the client. Treat a freshly-opened channel as valid for ~10 minutes — funds sent past that may end up in the broker's refund queue. THORChain routes carry `expiration` and are enforced strictly.
- **Chainflip `/track` lookup by deposit address is best-effort.** Chainflip's v2 swap API does not resolve raw deposit addresses; it accepts swap IDs / channel IDs / inbound tx hashes. Once you have the BTC hash, prefer it. The `depositAddress` you pass to `trackBridge` works as a hint for swap-engine's fallback chain but isn't guaranteed to hit.
- **Memo length is capped at 80 bytes** (Bitcoin standardness). swap-engine emits ~70-byte memos for THORChain routes — comfortable headroom — but if the destination address or affiliate tag pushes the memo past 80 bytes, the broadcast will throw `RangeError` from the wallet. Chainflip routes don't use memos.
- **THORChain `expiration` is enforced before broadcast.** Stale quotes (past the expiration timestamp) throw `SwapDKUserError` — re-quote and retry.
- **Tracking returns `null` for the first ~10–15 minutes** while the BTC tx confirms (1 block). `waitForBridge` defaults to a 15-minute timeout; raise it via `timeoutMs` for slow blocks.

## License

MIT
