# @swapdk/wdk-protocol-bridge-swapdk-tron

WDK bridge protocol module for cross-chain swaps from **TRON** as source. Pairs with [`@swapdk/wdk-wallet-tron`](https://www.npmjs.com/package/@swapdk/wdk-wallet-tron) (a fork of `@tetherto/wdk-wallet-tron` that adds raw-calldata `sendTransaction` for arbitrary smart-contract calls) to route TRX / TRC-20 USDT → any destination supported by THORChain / MAYAChain via the SwapDK swap-engine.

## How it works

```
WDK App
  └── SwapDKBridgeTron(tronAccount, config)
        ├── quoteBridge() → POST /quote (includeTx:false) → estimate
        └── bridge()      → POST /quote (includeTx:true) → POST /swap
                            └── TRC-20: account.sendTransaction({ approve calldata })
                                        ├─ wait for confirmation
                                        └─ account.sendTransaction({ depositWithExpiry calldata })
                                TRX:    account.sendTransaction({ depositWithExpiry calldata, callValue })
```

TRON inbound on THORChain uses the same **router-contract pattern as EVM** — `THOR_router.depositWithExpiry(vault, asset, amount, memo, expiration)` — just with base58 addresses and SUN as the value unit. swap-engine's TRON dispatch returns:
- `tx.to` — base58 router address (tronweb consumes directly)
- `tx.data` — full ABI-encoded calldata
- `tx.value` — callValue in SUN (decimal string) — populated for native TRX deposits, `"0"` for TRC-20
- `tx.feeLimit` — SUN cap on energy
- `approvalTx` — populated for TRC-20 sells (USDT/USDC approve)

The wallet receives these as `sendTransaction({ to, value, data, feeLimit })` and emits a `TriggerSmartContract` with the raw calldata.

Chainflip TRON source is **not** supported in v1 — it uses a deposit-channel model (analogous to Chainflip BTC source) that the bridge module hasn't wired yet; Chainflip-only quotes are rejected upfront with a clear `SwapDKUserError`.

## Install

```bash
npm install @swapdk/wdk-protocol-bridge-swapdk-tron \
            @swapdk/wdk-wallet-tron \
            @tetherto/wdk-wallet
```

## Usage

```ts
import WalletManagerTron from '@swapdk/wdk-wallet-tron'
import { SwapDKBridgeTron } from '@swapdk/wdk-protocol-bridge-swapdk-tron'

const wallet = new WalletManagerTron('abandon abandon …', "0'/0/0", {
  provider: 'https://api.trongrid.io',
})
const account = await wallet.getAccount(0)

const bridge = new SwapDKBridgeTron(account, {
  apiUrl: 'https://api.swapdk.com',
  apiKey: process.env.SWAPDK_API_KEY!,
  slippageBps: 300,        // 3 %
})
bridge.setSourceChain('tron')

// Quote (free, doesn't broadcast)
const quote = await bridge.quoteBridge({
  amount: 100_000_000n,    // 100 TRX in SUN (TRX has 6 decimals)
  targetChain: 'ethereum',
  tokenOut: 'ETH.ETH',
  recipient: '0xRecipient…',
})

// Execute — native TRX path: single contract call to THORChain router
const result = await bridge.bridge({
  amount: 100_000_000n,
  targetChain: 'ethereum',
  tokenOut: 'ETH.ETH',
  recipient: '0xRecipient…',
})
// {
//   hash:           '<tron-txid>',
//   fee:            <SUN feeLimit cap>,
//   approveHash:    undefined,     // TRX path — no approval needed
//   bridgeFee:      <SUN>,
//   bridgeFeeAsset: 'TRON.TRX',
//   tokenInAmount:  100_000_000n,
//   tokenOutAmount: <wei>,
// }

// TRC-20 USDT path — bridge() emits an approve + depositWithExpiry pair
const usdtResult = await bridge.bridge({
  token: 'TRON.USDT-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  amount: 10_000_000n,     // 10 USDT (6 decimals)
  targetChain: 'ethereum',
  tokenOut: 'ETH.ETH',
  recipient: '0xRecipient…',
})
// { ..., approveHash: '<tron-approve-txid>' }

// Track THORChain progress (poll until terminal)
await bridge.waitForBridge(result.hash, undefined, {
  pollIntervalMs: 15_000,
  timeoutMs: 600_000,
  onUpdate: (s) => console.log(s.status),
})
```

## Configuration

| Field          | Type    | Default  | Notes |
|----------------|---------|----------|-------|
| `apiUrl`       | string  | —        | swap-engine base URL |
| `apiKey`       | string  | —        | sent as `x-api-key` |
| `slippageBps`  | number  | `300`    | basis points (300 = 3%) |
| `bridgeMaxFee` | bigint  | none     | SUN — throws if liquidity fee exceeds the cap |
| `timeoutMs`    | number  | `10_000` | HTTP request timeout |
| `retries`      | number  | `2`      | retries on network errors / 5xx |

## Source token forms

The `options.token` field accepts:
- `"native"` / omitted → native TRX
- `"TRX"` → native TRX (shortcut)
- `"TRON.TRX"` → native TRX (SwapKit notation)
- `"TRON.USDT-T…"` → TRC-20 in SwapKit notation with base58 contract suffix

A bare base58 contract address (`"T…"`) is **not** accepted — swap-engine's `ConvertToChainflipFormat` strips the address suffix and keeps the symbol; the symbol must be supplied verbatim.

## Caveats

- **Only THORChain / MAYAChain routes are supported in v1.** Chainflip TRON source uses a deposit-channel inbound model that this module hasn't wired yet — Chainflip-only quotes throw a clear `SwapDKUserError` mentioning the provider. Adding Chainflip support is tracked separately.
- **`fee` in the result is the SUN feeLimit cap committed to the contract call**, not the actual energy burn. TRON's energy/bandwidth model makes pre-broadcast fee estimation impossible without a TronWeb roundtrip; we surface the cap as the conservative upper bound (matches the wallet's behaviour).
- **TRC-20 paths always emit an approval tx.** swap-engine doesn't currently check existing allowance on-chain before generating the approvalTx, so every TRC-20 swap pays a small approval fee (a few SUN of bandwidth). Allowance pre-check is a future server-side optimisation.
- **Tracking returns `null` for the first ~30-60 seconds** while THORChain waits for TRON confirmation (1-2 blocks). `waitForBridge` defaults to 15-second polling and a 10-minute timeout.

## License

MIT
