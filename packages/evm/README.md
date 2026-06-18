# @swapdk/wdk-protocol-bridge-swapdk-evm

WDK protocol module for cross-chain and same-chain swaps via [SwapDK](https://swapdk.com). Extends the standard WDK `BridgeProtocol` and `SwapProtocol` base classes. Supports swaps from EVM source chains to any destination (BTC, TRON, other EVM) via THORChain, MAYAChain, and Chainflip, and same-chain DEX swaps (e.g. USDC → WETH on Ethereum).

## How it works

```
WDK wallet (EVM)
  ├── SwapDKBridgeEvm extends BridgeProtocol
  │     ├── quoteBridge()  →  swap-engine /quote          →  estimate
  │     └── bridge()       →  swap-engine /quote + /swap  →  wallet signs & broadcasts
  │
  └── SwapDKSwapEvm extends SwapProtocol
        ├── quoteSwap()    →  swap-engine /quote          →  estimate
        └── swap()         →  swap-engine /quote + /swap  →  wallet signs & broadcasts
```

All routing logic (choosing between THORChain, MAYAChain, Chainflip) happens server-side in swap-engine.

## Installation

```bash
npm install @swapdk/wdk-protocol-bridge-swapdk-evm
```

## Quick start

### Cross-chain bridge: ETH → BTC

```typescript
import { SwapDKBridgeEvm } from '@swapdk/wdk-protocol-bridge-swapdk-evm';

const bridge = new SwapDKBridgeEvm(walletAccount, {
  apiUrl: 'https://api.swapdk.com',
  apiKey: 'your-api-key',
});
bridge.setSourceChain('ethereum');

// Get a quote
const quote = await bridge.quoteBridge({
  targetChain: 'bitcoin',
  recipient: 'bc1qxyz...',
  token: '0x0000000000000000000000000000000000000000', // native ETH
  amount: 1_000_000_000_000_000_000n, // 1 ETH
});

console.log(quote.tokenOutAmount); // expected BTC in satoshi
console.log(quote.providers);      // e.g. ["THORCHAIN"]

// Execute the bridge
const result = await bridge.bridge({
  targetChain: 'bitcoin',
  recipient: 'bc1qxyz...',
  token: '0x0000000000000000000000000000000000000000',
  amount: 1_000_000_000_000_000_000n,
});

console.log(result.hash);          // tx hash on Ethereum
console.log(result.approveHash);   // ERC-20 approval hash (if needed)
```

### Tracking a bridge

`bridge()` returns as soon as the source-chain transaction is broadcast, but a cross-chain swap completes later — after the deposit is observed, the swap executes on THORChain/MAYAChain, and the output asset is delivered on the destination chain. Use the tracking API to follow that lifecycle.

```typescript
// One-shot status lookup
const status = await bridge.trackBridge(result.hash);
if (status === null) {
  // Hash not yet indexed in Midgard — retry in a moment.
} else {
  console.log(status.status);      // "pending" | "swapping" | "completed" | "refunded" | "failed"
  console.log(status.toAmount);    // delivered amount (string, human-decimal)
}

// Poll until the bridge finishes (or timeout)
const final = await bridge.waitForBridge(result.hash, undefined, {
  pollIntervalMs: 15_000,   // 15 s between polls (default)
  timeoutMs:      600_000,  // give up after 10 min (default)
  onUpdate: (s) => console.log(`  [${s.status}] ${s.fromAmount} ${s.fromAsset} → ${s.toAmount} ${s.toAsset}`),
});
console.log(`Final: ${final.status}`);
```

Tracking is implemented only for THORChain and MAYAChain routes. Chainflip-routed bridges return `null` from `trackBridge()` until a separate adapter ships.

### Same-chain swap: USDC → native ETH

```typescript
import { SwapDKSwapEvm } from '@swapdk/wdk-protocol-bridge-swapdk-evm';

const swapper = new SwapDKSwapEvm(walletAccount, {
  apiUrl: 'https://api.swapdk.com',
  apiKey: 'your-api-key',
});
swapper.setSourceChain('ethereum');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NATIVE = '0x0000000000000000000000000000000000000000';

// Get a quote
const quote = await swapper.quoteSwap({
  tokenIn:  USDC,
  tokenOut: NATIVE,            // native ETH
  tokenInAmount: 100_000_000n, // 100 USDC (6 decimals)
});

console.log(quote.tokenOutAmount); // expected ETH in wei
console.log(quote.fee);            // estimated gas in wei

// Execute the swap
const result = await swapper.swap({
  tokenIn:       USDC,
  tokenOut:      NATIVE,
  tokenInAmount: 100_000_000n,
});

console.log(result.hash);        // tx hash
console.log(result.approveHash); // ERC-20 approval hash (if needed)
```

> Same-chain pair support is limited to what the underlying providers list. At v1.0 the cleanest coverage is between native gas tokens (ETH, BNB, AVAX, …) and USDC/USDT on each chain, routed via Chainflip. Pairs like USDC ↔ WETH are not yet supported because Chainflip doesn't list WETH as a quotable asset; these will be addressed by a future DEX adapter.

### Cross-chain ERC-20 swap

```typescript
// USDC on Ethereum → TRX on TRON
const result = await bridge.bridge({
  targetChain: 'tron',
  recipient: 'TXyz...',
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  amount: 100_000_000n, // 100 USDC (6 decimals)
});
```

### Specifying the destination token

```typescript
// ETH on Ethereum → USDT on TRON (not native TRX)
const result = await bridge.bridge({
  targetChain: 'tron',
  recipient: 'TXyz...',
  token: '0x0000000000000000000000000000000000000000',
  amount: 500_000_000_000_000_000n, // 0.5 ETH
  tokenOut: 'TRON.USDT',
});
```

## Supported chains

### Source (EVM)

| Chain | Identifier |
|---|---|
| Ethereum | `ethereum` |
| Arbitrum | `arbitrum` |
| Base | `base` |
| BSC | `bsc` |
| Avalanche | `avalanche` |
| Optimism | `optimism` |
| Polygon | `polygon` |

### Destination (bridge only)

Any chain supported by swap-engine: Bitcoin, TRON, Ethereum, Arbitrum, Base, BSC, Avalanche, Optimism, Polygon, Litecoin, Dogecoin.

## Supported tokens

Native gas tokens are always supported — pass the zero address (`0x0000…0000`) as `token`.

For ERC-20 tokens, the module carries a **known-token registry** (`src/known-tokens.ts`) mapping canonical contract addresses to `{ symbol, decimals }` per chain. An address that isn't in the registry will throw `SwapDKUserError`, because swap-engine routes by symbol and cannot recover one from an unknown address.

Out of the box the registry covers:

- **USDC** (including bridged USDC.e on Arbitrum, Optimism, Polygon)
- **USDT**
- **WETH** on Ethereum / Arbitrum / Base / Optimism (currently quotable only on the bridge path, not same-chain — Chainflip doesn't list WETH)
- **WBTC** on Ethereum / Arbitrum
- **DAI** on Ethereum
- **WBNB** on BSC, **WAVAX** on Avalanche, **WMATIC** on Polygon

### Extending the registry at runtime

For tokens that aren't shipped out of the box, call `registerToken()` once at app startup — before any `bridge()` / `quoteBridge()` / `swap()` / `quoteSwap()` that references the address.

```typescript
import { registerToken } from '@swapdk/wdk-protocol-bridge-swapdk-evm';

// e.g. FRAX on Ethereum
registerToken(
  'ethereum',
  '0x853d955acef822db058eb8505911ed77f175b99e',
  { symbol: 'FRAX', decimals: 18 },
);
```

The registry is a module-level singleton — every `SwapDKBridgeEvm` and `SwapDKSwapEvm` instance in the same process sees the addition immediately. Calling it twice for the same address overwrites the previous entry. Inputs are validated: invalid addresses, empty symbols, and bogus decimals throw `SwapDKUserError` synchronously, so you learn about the mistake at registration time rather than on the first HTTP call.

> ⚠️ A successful registration does **not** mean the token is routable. Swap-engine still has to recognise the symbol upstream (Chainflip / THORChain / MAYAChain). If the upstream provider doesn't list it, `quoteBridge` / `quoteSwap` will surface a `SwapDKProviderError` with "no routes found".

If you find yourself registering the same canonical token every run, consider sending a PR to `src/known-tokens.ts` so everyone benefits.

## Configuration

Both `SwapDKBridgeEvm` and `SwapDKSwapEvm` accept the same config object:

```typescript
interface SwapDKBridgeConfig {
  apiUrl: string;           // swap-engine base URL
  apiKey: string;           // SwapDK API key (x-api-key header)
  bridgeMaxFee?: bigint;    // max estimated gas (wei) per bridge tx
  swapMaxFee?: bigint;      // max estimated gas (wei) per same-chain swap tx
  slippageBps?: number;     // slippage tolerance in bps, default 300 (3%)
  timeoutMs?: number;       // HTTP request timeout in ms, default 10_000
  retries?: number;         // max retries on 5xx / network errors, default 2
}
```

`bridgeMaxFee` and `swapMaxFee` cause the respective method to throw `SwapDKUserError` before sending any transaction if the estimated gas exceeds the limit.

## Error handling

```typescript
import {
  SwapDKUserError,     // invalid input or fee limit exceeded
  SwapDKProviderError, // no usable routes returned by swap-engine
  SwapDKApiError,      // non-2xx HTTP response from swap-engine
  SwapDKNetworkError,  // network failure (timeout, DNS, connection refused)
} from '@swapdk/wdk-protocol-bridge-swapdk-evm';

try {
  const result = await bridge.bridge({ ... });
} catch (err) {
  if (err instanceof SwapDKUserError)     { /* fix the call */ }
  if (err instanceof SwapDKProviderError) { /* no route — try different pair */ }
  if (err instanceof SwapDKApiError)      { /* err.status, err.errorCode */ }
  if (err instanceof SwapDKNetworkError)  { /* connectivity issue */ }
}
```

## WDK app integration

See [`examples/wdk-app.ts`](./examples/wdk-app.ts) for a complete scaffold.

```typescript
import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { SwapDKBridgeEvm, SwapDKSwapEvm } from "@swapdk/wdk-protocol-bridge-swapdk-evm";

const wdk = new WDK(seedPhrase)
  .registerWallet("ethereum", WalletManagerEvm, { provider: ETH_RPC_URL })
  // Cross-chain bridge (ETH → BTC, TRON, etc.)
  .registerProtocol("ethereum", "swap-dk-bridge", SwapDKBridgeEvm, {
    apiUrl: "https://api.swapdk.com",
    apiKey: "your-api-key",
    bridgeMaxFee: 10_000_000_000_000_000n, // 0.01 ETH
  })
  // Same-chain swap (USDC → WETH on Ethereum)
  .registerProtocol("ethereum", "swap-dk-swap", SwapDKSwapEvm, {
    apiUrl: "https://api.swapdk.com",
    apiKey: "your-api-key",
    swapMaxFee: 5_000_000_000_000_000n, // 0.005 ETH
  });

const account = await wdk.getAccount("ethereum", 0);

const bridge  = account.getBridgeProtocol("swap-dk-bridge");
const swapper = account.getSwapProtocol("swap-dk-swap");
```

## Development

This package lives in the [`wdk-protocol-bridges-swapdk`](../../) monorepo. Build and lint commands run per-package; tests run from the monorepo root.

```bash
# From this package directory
npm run build      -w @swapdk/wdk-protocol-bridge-swapdk-evm   # compile to dist/
npm run dev        -w @swapdk/wdk-protocol-bridge-swapdk-evm   # watch mode
npm run lint       -w @swapdk/wdk-protocol-bridge-swapdk-evm   # type-check only

# From the repo root
npm test                                                       # vitest, all packages
npm test -- packages/evm                                       # filter to this package
```

---

## Roadmap

### v0.1 — Foundation

- [x] Core `SwapDKBridgeEvm` class with `bridge()` and `quoteBridge()`
- [x] HTTP client for swap-engine `/quote` and `/swap` endpoints
- [x] Asset mapping: WDK token addresses to SwapKit notation
- [x] ERC-20 approval handling (`approvalTx`)
- [x] TypeScript types for all swap-engine API responses

### v0.2 — Testing & WDK integration

- [x] Unit tests for `asset-map`, `SwapDKClient`, `SwapDKBridgeEvm` — 95%+ branch coverage
- [x] Extend `BridgeProtocol` from `@tetherto/wdk-wallet/protocols`
- [x] SwapDK-specific types extend WDK base types
- [x] Scaffold WDK app example (`examples/wdk-app.ts`)

### v0.3 — Production hardening

- [x] Re-quote on stale `routeId` (auto-retry when routeId expires between quote and swap)
- [x] `bridgeMaxFee` / `swapMaxFee` enforcement
- [x] Timeout and retry policy for swap-engine HTTP calls (exponential backoff)
- [x] Error classification: `SwapDKUserError`, `SwapDKProviderError`, `SwapDKApiError`, `SwapDKNetworkError`

### v0.4 — Swap protocol support

- [x] `SwapDKSwapEvm` implementing WDK `SwapProtocol` (`swap()` + `quoteSwap()`)
- [x] Same-chain EVM swaps (e.g. USDC → WETH on Ethereum via DEX)
- [x] Register as both bridge and swap protocol in a single WDK app

### v1.0 — Stable release

Infrastructure:
- [x] CI/CD pipeline (lint, test, smoke test, publish on tag)
- [x] WDK runtime integration verified end-to-end via real WDK wallet
- [x] `nodenext` module resolution (strict Node.js ESM)
- [x] Package metadata (`repository`, `author`, `prepack`, `LICENSE`, `.npmignore`)

Correctness at the swap-engine HTTP boundary:
- [x] **`sellAmount` sent as human-decimal strings** (`"0.01"` not `"10000000000000000"` wei)
- [x] **Real ERC-20 symbols in asset notation** via a hardcoded known-token registry (`ETH.USDC-0xAddr`, not the `ETH.ETH-0xAddr` placeholder)
- [x] **`expectedBuyAmount` parsed back into native decimals** (satoshi, wei, etc.) for WDK consumers
- [x] **`pickBestRoute()`** — avoid blind `routes[0]` when swap-engine returns a zero-quote provider ahead of the real one
- [x] Unit test fixtures rewritten to match the real swap-engine contract
- [x] End-to-end verified: `quoteBridge 0.01 ETH → BTC` returns ~30,581 sat; `quoteSwap 100 USDC → ETH` returns ~0.0416 ETH in wei
- [ ] Published to npm as `@swapdk/wdk-protocol-bridge-swapdk-evm`

### Post-1.0 — lifecycle & tracking

- [x] **Bridge tracking API** — `trackBridge()` + `waitForBridge()` wrapping swap-engine's `/track` endpoint (THORChain + MAYAChain)
- [x] Companion fix in swap-engine: `/track` now returns 404 for "hash not in Midgard" instead of 502 (so proxies like Cloudflare don't hide the JSON body)
- [x] **`registerToken()`** — runtime extension of the known-token registry for ERC-20s that aren't shipped
- [ ] Chainflip-route tracking (blocked on upstream swap-engine — currently returns `null` for Chainflip hashes)

### Future

- [ ] `@swapdk/wdk-protocol-bridge-swapdk-btc` — BTC as source chain. **Blocked** on upstream `@tetherto/wdk-wallet-btc` lacking OP_RETURN support in `sendTransaction`; THORChain routing won't work without it. Full research: [docs/research-btc-source.md](./docs/research-btc-source.md).
- [x] **`@swapdk/wdk-protocol-bridge-swapdk-solana`** — Solana as source chain. Initial 0.1.0 scaffold shipped: native SOL → any destination via THORChain, with `trackBridge` / `waitForBridge` / `registerToken`. SPL source pending. Lives in a sibling repo.
- [ ] `@swapdk/wdk-protocol-bridge-swapdk-tron` — TRON as source chain. **Blocked** on two layers: (1) swap-engine doesn't dispatch TRON in `utils/swap_engine.go` (TRON is in none of the `isEvmChain` / `isUtxoChain` / `isCosmosChain` predicates), (2) `@tetherto/wdk-wallet-tron@1.0.0-beta.5` has no `callContract` method — only plain TRX transfers and hardcoded TRC-20 `transfer(address,uint256)`. Full research: [docs/research-tron-source.md](./docs/research-tron-source.md).
- [ ] Streaming swaps support (THORChain DCA parameters)
- [ ] On-chain ERC-20 symbol resolution for tokens outside the registry (automated fallback; complements `registerToken()`)

## License

MIT
