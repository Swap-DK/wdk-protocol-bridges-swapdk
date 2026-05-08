# @swapdk/wdk-protocol-bridge-swapdk-cosmos

WDK bridge protocol module for cross-chain swaps with **THORChain (RUNE)** or **MAYAChain (CACAO)** as the source asset.

Use it to:

- Quote and execute swaps from RUNE or CACAO to any chain swap-engine routes (BTC, ETH, USDC on EVM, etc.).
- Track an in-flight bridge by source-chain transaction hash.
- Wait for a swap to reach a terminal state (`completed`, `refunded`, `failed`).

The module is a thin wrapper: get a quote and the swap memo from the SwapDK swap-engine, then sign and broadcast either a `MsgDeposit` (protocol-native routes) or a `MsgSend` to an inbound vault (cross-protocol routes) through your Cosmos wallet. Route shape detection is automatic — see [Route dispatch](#route-dispatch--msgdeposit-vs-msgsend).

## Installation

```bash
npm install @swapdk/wdk-protocol-bridge-swapdk-cosmos \
            @swapdk/wdk-wallet-cosmos \
            @tetherto/wdk-wallet
```

`@swapdk/wdk-wallet-cosmos` is a peer dependency — supply your own version. Any wallet implementing the `CosmosWalletAccount` interface (`getAddress()` + `deposit(...)` + `transfer(...)`) works.

## Quick start

### THORChain → Bitcoin

```typescript
import WalletManagerCosmos, {
  THORCHAIN_PRESET,
} from "@swapdk/wdk-wallet-cosmos";
import { SwapDKBridgeCosmos } from "@swapdk/wdk-protocol-bridge-swapdk-cosmos";

// 1. Build a Cosmos wallet on THORChain
const wallet = new WalletManagerCosmos(seedPhrase, {
  ...THORCHAIN_PRESET,
  rpcEndpoints: ["https://rpc.thorchain.info"],
});
const account = await wallet.getAccount(0);

// 2. Build the bridge
const bridge = new SwapDKBridgeCosmos(account, {
  apiUrl: "https://api.swapdk.com",
  apiKey: process.env.SWAPDK_API_KEY!,
});
bridge.setSourceChain("thorchain");

// 3. Quote — see what you'd get without executing
const quote = await bridge.quoteBridge({
  token: "native",            // shorthand for THOR.RUNE
  amount: 100_000_000n,       // 1 RUNE in base units (1e8)
  targetChain: "bitcoin",
  recipient: "bc1qrecipient…",
});
console.log(quote.tokenOutAmount);   // BTC out, in base units (8 decimals)
console.log(quote.estimatedTime);    // seconds
console.log(quote.providers);        // ["THORCHAIN"]

// 4. Execute
const result = await bridge.bridge({
  token: "native",
  amount: 100_000_000n,
  targetChain: "bitcoin",
  recipient: "bc1qrecipient…",
});
console.log(result.hash);            // THORChain deposit tx hash

// 5. Track until terminal
const final = await bridge.waitForBridge(result.hash, undefined, {
  pollIntervalMs: 15_000,
  onUpdate: (s) => console.log(s.status, s.trackingStatus),
});
```

### MAYAChain → Ethereum (USDC)

```typescript
import WalletManagerCosmos, {
  MAYACHAIN_PRESET,
} from "@swapdk/wdk-wallet-cosmos";

const wallet = new WalletManagerCosmos(seedPhrase, {
  ...MAYACHAIN_PRESET,
  rpcEndpoints: ["https://tendermint.mayachain.info"],
});
const account = await wallet.getAccount(0);

const bridge = new SwapDKBridgeCosmos(account, {
  apiUrl: "https://api.swapdk.com",
  apiKey: process.env.SWAPDK_API_KEY!,
});
bridge.setSourceChain("mayachain");

const result = await bridge.bridge({
  token: "native",                    // CACAO
  amount: 10_000_000_000n,            // 1 CACAO (10 decimals)
  targetChain: "ethereum",
  tokenOut: "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  recipient: "0xRecipient…",
});
```

## API

### `new SwapDKBridgeCosmos(account, config)`

| Param     | Type                       | Description                                     |
| --------- | -------------------------- | ----------------------------------------------- |
| `account` | `CosmosWalletAccount`      | Anything with `getAddress()`, `deposit(...)`, and `transfer(...)`. |
| `config`  | `SwapDKBridgeConfig`       | API URL, key, and behavior toggles.             |

#### `SwapDKBridgeConfig`

| Field            | Type      | Default | Description                                                                                       |
| ---------------- | --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `apiUrl`         | `string`  | —       | swap-engine base URL. Required.                                                                   |
| `apiKey`         | `string`  | —       | swap-engine API key (sent as `x-api-key`). Required.                                              |
| `bridgeMaxFee`   | `bigint`  | —       | Cap on the route's `liquidity` fee (base units of source asset). `bridge()` and `quoteBridge()` throw if exceeded. |
| `slippageBps`    | `number`  | `300`   | Default slippage in basis points (3 %).                                                           |
| `timeoutMs`      | `number`  | `10_000` | Per-request timeout.                                                                             |
| `retries`        | `number`  | `2`     | Max retries on network errors and 5xx.                                                            |

### `bridge.setSourceChain(chain)`

Pass `"thorchain"` or `"mayachain"` (case-insensitive). Determines which network the deposit is signed against and what `chainId` `trackBridge()` uses by default.

### `bridge.quoteBridge(options)` → `Promise<SwapDKBridgeQuoteResult>`

Get a non-binding estimate. Doesn't sign, doesn't broadcast.

### `bridge.bridge(options)` → `Promise<SwapDKBridgeResult>`

Execute the swap: re-quote, fetch the swap memo from `/swap`, then dispatch to `walletAccount.deposit()` or `walletAccount.transfer()` depending on the route shape (see [Route dispatch](#route-dispatch--msgdeposit-vs-msgsend)).

#### `SwapDKBridgeOptions` (input)

| Field         | Type            | Description                                                                                                                            |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `token`       | `string`        | The asset you're selling. One of: `"native"` (sentinel), bare denom (`"rune"`, `"cacao"`), or full SwapKit string (`"THOR.RUNE"`, `"MAYA.CACAO"`). |
| `amount`      | `bigint`        | Sell amount in base units (RUNE: 1e8, CACAO: 1e10).                                                                                    |
| `targetChain` | `string`        | WDK chain id of the destination — `"bitcoin"`, `"ethereum"`, `"arbitrum"`, etc.                                                        |
| `tokenOut`    | `string`        | (optional) Buy asset. Either a SwapKit string (`"BTC.BTC"`, `"ETH.USDC-0xA0b…"`) or a bare contract address. Defaults to the target chain's native. |
| `recipient`   | `string`        | Destination address.                                                                                                                   |

#### `SwapDKBridgeResult` / `SwapDKBridgeQuoteResult` (output)

| Field            | Type     | Description                                                                                          |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `hash`           | `string` | Source-chain deposit tx hash. Only on `bridge()`, not on `quoteBridge()`.                            |
| `fee`            | `bigint` | Source-chain gas fee paid (base units). For `quoteBridge()` always `0n` — the wallet sets gas at signing time. |
| `bridgeFee`      | `bigint` | Sum of `liquidity`-type fees from the route, best-effort (in base units of the source asset).        |
| `tokenInAmount`  | `bigint` | Amount actually consumed (base units).                                                               |
| `tokenOutAmount` | `bigint` | Expected output (base units of the destination asset).                                               |
| `estimatedTime`  | `number` | (quote only) Total seconds to completion.                                                            |
| `providers`      | `string[]` | (quote only) Routing providers, e.g. `["THORCHAIN"]`.                                              |

### `bridge.trackBridge(hash, chainId?)` → `Promise<TrackResponse | null>`

One-shot status lookup. Returns `null` if the hash isn't yet indexed by Midgard (the normal state in the seconds after `bridge()` returns).

`chainId` defaults to the SwapKit prefix of the active source chain (`"THOR"` or `"MAYA"`).

### `bridge.waitForBridge(hash, chainId?, opts?)` → `Promise<TrackResponse>`

Poll `trackBridge` until status is one of `completed`, `refunded`, `failed`, or until `timeoutMs` elapses (default 10 min).

| Option            | Default     | Description                                |
| ----------------- | ----------- | ------------------------------------------ |
| `pollIntervalMs`  | `15_000`    | Time between polls.                        |
| `timeoutMs`       | `600_000`   | Overall deadline.                          |
| `onUpdate`        | —           | Called for each non-null poll result.      |

Throws `SwapDKUserError` on timeout. Propagates non-404 HTTP errors.

## Errors

All errors extend `SwapDKError`:

| Class                 | When                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| `SwapDKUserError`     | Bad input (missing `amount`, unsupported source chain, fee over cap, etc.).            |
| `SwapDKApiError`      | swap-engine returned a 4xx/5xx. Carries `status`, `path`, `errorCode`. Has `isNotFound` (404 on `/track`) and `isStaleRoute` helpers. |
| `SwapDKProviderError` | swap-engine returned no usable routes. `providerErrors` lists why.                    |
| `SwapDKNetworkError`  | Transport-level failure (timeout, DNS, etc.) after retries are exhausted.             |

```typescript
import { SwapDKApiError } from "@swapdk/wdk-protocol-bridge-swapdk-cosmos";

try {
  await bridge.bridge({ ... });
} catch (err) {
  if (err instanceof SwapDKApiError && err.isStaleRoute) {
    // shouldn't happen — bridge() retries internally — but if it does,
    // re-quote and try again.
  }
  throw err;
}
```

## Memo handling

You don't construct the swap memo yourself. swap-engine generates it from the route, including slippage minimums, recipient address, and any affiliate fee. The bridge passes it through unchanged to `walletAccount.deposit()` (for `MsgDeposit` routes) or `walletAccount.transfer()` (for `MsgSend` routes).

If you need to inspect the memo before broadcasting (e.g. for confirmation UI), use `quoteBridge()` first — but note that the **canonical** memo only comes back from `/swap` (called inside `bridge()`), not `/quote`. Quotes are non-binding; the actual route may shift between quote and execute.

## Route dispatch — `MsgDeposit` vs `MsgSend`

swap-engine returns one of two route shapes for a Cosmos source, and `bridge()` dispatches to the matching wallet method automatically:

- **`MsgDeposit`** — protocol-native swap (THORChain-routed RUNE, MAYAChain-routed CACAO). The deposit goes to the user's own balance; the protocol's Asgard module observes the memo. Detected by an empty `inboundAddress` in the `/swap` response. Dispatched to `walletAccount.deposit({ asset, amount, memo })`.
- **`MsgSend`** — cross-protocol swap (e.g. RUNE → BTC routed via MAYAChain). The deposit goes to the *other* protocol's inbound vault on the source chain, with the swap memo attached to the tx body. Detected by a non-empty `inboundAddress` (≠ source). Dispatched to `walletAccount.transfer({ token, recipient, amount, memo })`.

Both paths require the swap memo from `/swap`. If the response has no memo (e.g. amount below the route's minimum, or a malformed route), `bridge()` throws `SwapDKUserError` rather than broadcasting — broadcasting either path with an empty memo would lose funds.

The wallet you pass must implement both `deposit` and `transfer`; `@swapdk/wdk-wallet-cosmos` does so out of the box.

## Limitations

- **Source chain must be THORChain or MAYAChain.** Other Cosmos-SDK chains (Cosmos Hub, Osmosis, …) aren't supported as source today; swap-engine doesn't route their natives. Add support for them by extending the engine first.
- **Trade asset deposits not yet supported.** The module forwards SwapKit-form `THOR.BTC-BTC` and similar trade-asset strings if you pass them, but the asset registry covers natives only — fees/decimals for trade assets fall back to chain-native defaults. Use with care.

## Platform support

| Platform     | Status |
| ------------ | ------ |
| Node.js 18+  | ✅      |
| Browser      | ✅      |
| React Native | ✅ with crypto polyfills |

## Security

- **The memo determines the destination chain and recipient.** swap-engine constructs it from your `recipient` parameter — verify the recipient before calling `bridge()`.
- **Set `bridgeMaxFee`** to bound runaway provider fees during volatile market conditions.
- The wallet's `transferMaxFee` is independent — set both for defense in depth.
- Use trusted RPC endpoints; the wallet does multi-endpoint fallback but RPC trust is still required.

## License

MIT. See [LICENSE](../../LICENSE).
