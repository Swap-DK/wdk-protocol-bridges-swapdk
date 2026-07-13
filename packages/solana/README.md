# @swapdk/wdk-protocol-bridge-swapdk-solana

> **Legacy interface — new integrations should prefer [`@swapdk/wdk-protocol-swidge-swapdk`](https://www.npmjs.com/package/@swapdk/wdk-protocol-swidge-swapdk).**
>
> This package implements the WDK `IBridgeProtocol` interface, which is soft-deprecated in favour of the newer `ISwidgeProtocol` (see the [WDK swidge modules documentation](https://docs.wdk.tether.io/sdk/swidge-modules/)). The swidge module ships a single class covering all five source-chain families — Bitcoin, EVM, Cosmos, Solana, and TRON — with the same Solana dispatch (native SOL transfer + Memo Program instruction) this package implements. Existing consumers remain supported and continue to receive bug fixes, but no new features will be added here.

WDK bridge protocol module for cross-chain swaps with **Solana as source** via [SwapDK](https://swapdk.com). Extends the standard WDK `BridgeProtocol` base class. Native SOL can be bridged to any destination supported by swap-engine (ETH, USDC on EVM chains, BTC, TRON, LTC, DOGE) via THORChain and MAYAChain.

## How it works

```
WDK wallet (Solana)
  └── SwapDKBridgeSolana extends BridgeProtocol
        ├── quoteBridge()  →  swap-engine /quote  →  returns estimate + inboundAddress + memo
        └── bridge()       →  swap-engine /quote  →  build Solana tx (transfer + Memo) → wallet signs & broadcasts
```

Unlike the EVM source module, swap-engine does **not** prepare a signed-ready `tx` payload for Solana routes — it returns the THORChain inbound vault address and the routing memo. This client constructs the Solana transaction itself: a `SystemProgram` transfer instruction alongside a Memo Program instruction carrying the memo bytes.

## Installation

```bash
npm install @swapdk/wdk-protocol-bridge-swapdk-solana \
            @tetherto/wdk @tetherto/wdk-wallet-solana
```

## Quick start

```typescript
import WDK from "@tetherto/wdk";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";
import { SwapDKBridgeSolana } from "@swapdk/wdk-protocol-bridge-swapdk-solana";

const wdk = new WDK(SEED_PHRASE)
  .registerWallet("solana", WalletManagerSolana, {
    rpcUrl: "https://api.mainnet-beta.solana.com",
  })
  .registerProtocol("solana", "swap-dk-bridge", SwapDKBridgeSolana, {
    apiUrl: "https://api.swapdk.com",
    apiKey: "your-api-key",
    slippageBps: 300,
  });

const account = await wdk.getAccount("solana", 0);
const bridge = account.getBridgeProtocol("swap-dk-bridge");

// Quote: 1 SOL → ETH
const quote = await bridge.quoteBridge({
  targetChain: "ethereum",
  recipient:   "0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54",
  token:       "",               // empty = native SOL
  amount:      1_000_000_000n,   // 1 SOL in lamports
});
console.log(quote.tokenOutAmount);   // expected ETH in wei
console.log(quote.inboundAddress);   // THORChain vault (rotates)
console.log(quote.memo);             // "=:e:0xe89E...:minOut:commission/SDK:...""

// Execute
const result = await bridge.bridge({
  targetChain: "ethereum",
  recipient:   "0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54",
  token:       "",
  amount:      1_000_000_000n,
});
console.log(result.hash);  // Solana tx signature
```

### Tracking the bridge

```typescript
const status = await bridge.trackBridge(result.hash);
// null → not yet indexed in Midgard; retry in a moment

const final = await bridge.waitForBridge(result.hash, undefined, {
  pollIntervalMs: 5_000,    // default — Solana slots are fast
  timeoutMs:      600_000,
  onUpdate: (s) => console.log(s.status),
});
```

Tracking is implemented for THORChain and MAYAChain routes only — the same upstream limitation as the EVM module.

## Source asset (SOL vs SPL)

- **Native SOL**: pass `token: ""`. Amount is in lamports (1 SOL = 10⁹).
- **SPL tokens**: not yet supported in this MVP. The transaction-builder currently emits a `SystemProgram` transfer; an SPL-source path needs a different instruction (SPL Token transfer). Tracked in the roadmap; filed an issue if you need a specific pair.

## Destination chains

Any chain swap-engine recognises as a THORChain/MAYAChain destination:
Ethereum / Arbitrum / Base / BSC / Avalanche / Optimism / Polygon / Bitcoin / Litecoin / Dogecoin / TRON.

Destination ERC-20s (for `tokenOut`): USDC, USDT, WETH, WBTC, DAI and wrapped natives out of the box. Extend via `registerToken()` — same API as in the EVM module.

## Configuration

```typescript
interface SwapDKBridgeConfig {
  apiUrl: string;           // swap-engine base URL
  apiKey: string;           // SwapDK API key (x-api-key header)
  bridgeMaxFee?: bigint;    // max tx fee (lamports) allowed per bridge tx
  slippageBps?: number;     // default 300 (3 %)
  timeoutMs?: number;       // HTTP timeout, default 10_000
  retries?: number;         // max retries on 5xx / network errors, default 2
}
```

`bridgeMaxFee` is enforced **before broadcast** against `SOLANA_BASE_FEE_LAMPORTS` (5 000). Solana charges 5 000 lamports per signature, our bridge tx has exactly one signature, and the tx-builder doesn't add a `ComputeBudgetProgram` priority-fee instruction — so the constant is accurate for what we actually send. `quoteBridge()` returns this same value as `fee` so callers can surface it in their UI without making any RPC call. The wallet still reports the *actual* fee after broadcast, which `bridge()` puts in the result for accounting; if a custom wallet wrapper adds priority fees on top, that surfaces there.

## Error handling

Same taxonomy as the EVM module:

```typescript
import {
  SwapDKUserError,     // invalid input or fee limit exceeded
  SwapDKProviderError, // swap-engine returned no usable routes
  SwapDKApiError,      // non-2xx HTTP response (check .isNotFound on /track 404s)
  SwapDKNetworkError,  // timeout / DNS / connection refused
} from "@swapdk/wdk-protocol-bridge-swapdk-solana";
```

## WDK app integration

See [`examples/wdk-app.ts`](./examples/wdk-app.ts) for a complete scaffold.

## Design notes

The full research behind this module — swap-engine response shape for SOL source, the exact WDK Solana wallet entry point we rely on, the memo-via-Memo-Program flow, and why SPL-source is a follow-up — is in [`docs/research-solana-source.md`](./docs/research-solana-source.md).

## Development

This package lives in the [`wdk-protocol-bridges-swapdk`](../../) monorepo. Build and lint commands run per-package; tests run from the monorepo root.

```bash
# From this package directory
npm run build      -w @swapdk/wdk-protocol-bridge-swapdk-solana   # compile to dist/
npm run dev        -w @swapdk/wdk-protocol-bridge-swapdk-solana   # watch mode
npm run lint       -w @swapdk/wdk-protocol-bridge-swapdk-solana   # type-check only

# From the repo root
npm test                                                          # vitest, all packages
npm test -- packages/solana                                       # filter to this package
```

## License

MIT
