# @swapdk/wdk-protocol-swidge-swapdk

WDK swidge protocol module for arbitrary-asset cross-chain swaps and bridges via the [SwapDK swap-engine](https://swapdk.com) (routing through THORChain, MAYAChain, and Chainflip). Single class covering Bitcoin, EVM, Cosmos-family, Solana, and TRON source chains.

> **Version 1.0.0-alpha.0.** API surface is stable enough for early integration, but breaking changes are still possible before 1.0.0.

## Install

```bash
npm install @swapdk/wdk-protocol-swidge-swapdk
```

You also need the WDK wallet module for your source chain family:

| Source chain | Peer wallet |
|---|---|
| Ethereum / Arbitrum / Base / BSC / Avalanche | `@tetherto/wdk-wallet-evm` |
| Bitcoin | `@swapdk/wdk-wallet-btc` (until the upstream `memo` PR lands in `@tetherto/wdk-wallet-btc`) |
| TRON (TRX / TRC-20) | `@tetherto/wdk-wallet-tron` + `tronweb` |
| THORChain (RUNE) / MAYAChain (CACAO) | `@base58-io/wdk-wallet-cosmos` or the SwapDK fork with `deposit()` |
| Solana (native SOL) | `@tetherto/wdk-wallet-solana` |

The base `@tetherto/wdk-wallet` is a peer dep pinned to exact `1.0.0-beta.11` (matches the [Rhino.fi swidge module](https://www.npmjs.com/package/@rhino.fi/wdk-protocol-swidge-rhinofi) pin; upstream `beta.12+` regressed the `SwidgeProtocol` re-export from `/protocols/index.js`).

## Quick start

```ts
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { SwapDKSwidge } from "@swapdk/wdk-protocol-swidge-swapdk";

const wallet = new WalletManagerEvm(seedPhrase, { provider: process.env.RPC_URL_ETHEREUM });
const account = await wallet.getAccount(0);

const swidge = new SwapDKSwidge(account, {
  apiUrl: "https://api.swapdk.com",
  apiKey: process.env.SWAPDK_API_KEY!,
  defaultFromChain: "ethereum",
});

// 1. Discovery — no wallet needed
const chains = await swidge.getSupportedChains();
const tokens = await swidge.getSupportedTokens({ fromChain: "ethereum" });

// 2. Non-binding quote
const quote = await swidge.quoteSwidge({
  fromToken: "ETH",
  fromChain: "ethereum",
  toToken: "BTC",
  toChain: "bitcoin",
  fromTokenAmount: 10_000_000_000_000_000n, // 0.01 ETH
  recipient: "bc1qexampleRecipient…",
  slippage: 0.01,
});
console.log("expected BTC out:", quote.toTokenAmount);

// 3. Execute (broadcasts the source-chain transaction)
const result = await swidge.swidge({
  fromToken: "ETH",
  fromChain: "ethereum",
  toToken: "BTC",
  toChain: "bitcoin",
  fromTokenAmount: 10_000_000_000_000_000n,
  recipient: "bc1qexampleRecipient…",
});
console.log("source tx:", result.hash);

// 4. Poll the destination leg
const status = await swidge.getSwidgeStatus(result.id, { fromChain: "ethereum" });
if (status.status === "completed") { /* … */ }
```

## API

Implements the [`ISwidgeProtocol`](https://docs.wdk.tether.io/sdk/swidge-modules/) interface from `@tetherto/wdk-wallet/protocols`:

| Method | Purpose |
|---|---|
| `getSupportedChains()` | Live list of routable source + destination chains (halt-filtered server-side). |
| `getSupportedTokens(options?)` | Discoverable tokens with optional `fromChain` / `toChain` filter. |
| `quoteSwidge(options)` | Non-binding quote. Reads only; safe without a wallet. |
| `swidge(options, config?)` | Execute — signs and broadcasts the source-chain deposit. |
| `getSwidgeStatus(id, options?)` | Look up the swidge status for a broadcast source-tx hash. |

Because the base `SwidgeProtocol` implements `bridge/quoteBridge/swap/quoteSwap` by delegating to `swidge/quoteSwidge`, downstream consumers still on the legacy `IBridgeProtocol` / `ISwapProtocol` API get compatibility for free.

## Options

### `SwapDKSwidgeConfig`

| Field | Type | Notes |
|---|---|---|
| `apiUrl` | `string` | SwapDK swap-engine base URL. Required. |
| `apiKey` | `string` | SwapDK API key. Sent as `x-api-key`. Required. |
| `defaultFromChain` | `string` | Falls back for options that omit `fromChain`. |
| `defaultSlippage` | `number` | Decimal (0.03 = 3%). Default: 0.03. |
| `timeoutMs` | `number` | HTTP timeout. Default: 10 000. |
| `retries` | `number` | Retry count on network errors / 5xx (for idempotent endpoints). Default: 2. |
| `feeRate` | `number \| bigint` | Bitcoin miner-fee (sats/vB). BTC adapter only; ignored elsewhere. |
| `chainflip` | `object` | Chainflip broker-channel defaults (`refundMinPrice`, `refundRetryDuration`, `dcaChunks`, `dcaChunkInterval`, `maxBoostFeeBps`). BTC adapter only. |
| `tronWeb` | `TronWebLike` | TronWeb instance. Required for TRON sources; ignored elsewhere. |

### `SwapDKSwidgeOptions`

Extends the base `SwidgeOptions` with `fromChain` (required for multi-family source support). Fields:

- `fromToken`, `toToken` — provider-specific identifiers (native ticker for gas coins, contract address for fungibles — matches `getSupportedTokens()` output).
- `fromChain`, `toChain` — swidge chain ids (`"ethereum"`, `"bitcoin"`, `"tron"`, etc.).
- `recipient`, `refundAddress` — destination + refund addresses.
- `slippage` — decimal, mutually exclusive with `minAmountOut`.
- `fromTokenAmount` — exact-in amount in base units. Mutually exclusive with `toTokenAmount`.
- `toTokenAmount` — exact-out. **Not yet supported by the swap-engine**; adapter throws `SwapDKUserError` if passed.

## Known limits (v1.0.0-alpha)

- **`SwidgeProtocolConfig.maxNetworkFeeBps` / `maxProtocolFeeBps` are accepted but currently no-op.** The module returns fee data on `SwidgeResult.fees` so callers can enforce caps client-side. Server-side enforcement lands in a subsequent release.
- **`minAmountOut` is accepted but not forwarded to `/quote`.** Use `slippage` to control slippage tolerance until this ships.
- **Solana source: native SOL only.** SPL tokens require a separate SPL-Token instruction path (roadmap).
- **`getSupportedTokens.fromToken` filter is accepted but not applied server-side** — the backend returns the full token list scoped to `fromChain`.

## Chain-family adapters

The `swidge()` execution path dispatches to a per-source-chain adapter internally. Each adapter is a small module that translates the swap-engine response into the concrete tx shape the paired wallet expects:

| Source | Adapter | Provider paths |
|---|---|---|
| EVM | `evmAdapter` | Router-contract call (+ optional ERC-20 approve leg) via `wallet.sendTransaction({to, data, value, gas})` |
| Bitcoin | `btcAdapter` | THORChain: `sendTransaction({to: vault, value, memo})` (memo → OP_RETURN). Chainflip: broker-channel + plain BTC transfer to allocated address. |
| TRON | `tronAdapter` | Router: `tronWeb.transactionBuilder.triggerSmartContract(...)` → prebuilt tx → `wallet.sendTransaction(prebuiltTx)`. Direct-vault: `sendTrx + addUpdateData` (memo in `raw_data.data`). |
| Cosmos | `cosmosAdapter` | THORChain / MAYAChain protocol-native: `wallet.deposit({asset, amount, memo})`. Cross-protocol: `wallet.transfer({token, recipient, amount, memo})`. |
| Solana | `solanaAdapter` | Native-SOL transfer + Memo Program instruction; single `wallet.sendTransaction(transactionMessage)`. |

## Source

- Monorepo: https://github.com/Swap-DK/wdk-protocol-bridges-swapdk
- Package: `packages/swidge/`
- Adjacent legacy per-source-chain packages (still supported for existing consumers): `packages/{btc,cosmos,evm,solana,tron}/`

## License

MIT
