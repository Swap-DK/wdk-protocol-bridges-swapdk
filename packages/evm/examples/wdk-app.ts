/**
 * Minimal WDK app scaffold demonstrating how to register and use
 * SwapDKBridgeEvm (cross-chain bridge) and SwapDKSwapEvm (same-chain swap)
 * as WDK protocol modules.
 *
 * Prerequisites:
 *   npm install @tetherto/wdk @tetherto/wdk-wallet-evm @swapdk/wdk-protocol-bridge-swapdk-evm
 *
 * Run:
 *   npx tsx examples/wdk-app.ts
 */

import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { SwapDKBridgeEvm, SwapDKSwapEvm } from "@swapdk/wdk-protocol-bridge-swapdk-evm";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEED_PHRASE = process.env.SEED_PHRASE ?? "";
const SWAP_ENGINE_URL = process.env.SWAP_ENGINE_URL ?? "https://api.swapdk.com";
const SWAP_ENGINE_KEY = process.env.SWAP_ENGINE_KEY ?? "";
const ETH_RPC_URL = process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com";

if (!SEED_PHRASE || !SWAP_ENGINE_KEY) {
  console.error("Required env vars: SEED_PHRASE, SWAP_ENGINE_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WDK setup — register both bridge and swap protocol on Ethereum
// ---------------------------------------------------------------------------

const wdk = new WDK(SEED_PHRASE)
  // Register the EVM wallet manager for Ethereum
  .registerWallet("ethereum", WalletManagerEvm, {
    provider: ETH_RPC_URL,
  })
  // Register SwapDK bridge protocol (cross-chain: ETH → BTC, TRON, etc.)
  .registerProtocol("ethereum", "swap-dk-bridge", SwapDKBridgeEvm, {
    apiUrl: SWAP_ENGINE_URL,
    apiKey: SWAP_ENGINE_KEY,
    slippageBps: 300,        // 3% default slippage
    bridgeMaxFee: 10_000_000_000_000_000n, // 0.01 ETH max fee
  })
  // Register SwapDK swap protocol (same-chain: USDC → WETH on Ethereum)
  .registerProtocol("ethereum", "swap-dk-swap", SwapDKSwapEvm, {
    apiUrl: SWAP_ENGINE_URL,
    apiKey: SWAP_ENGINE_KEY,
    slippageBps: 300,
    swapMaxFee: 5_000_000_000_000_000n, // 0.005 ETH max fee
  });

// ---------------------------------------------------------------------------
// Example A: ETH → BTC cross-chain bridge
// ---------------------------------------------------------------------------

async function exampleBridge() {
  const account = await wdk.getAccount("ethereum", 0);
  const bridge = account.getBridgeProtocol("swap-dk-bridge");

  const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
  const BTC_RECIPIENT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // testnet-safe P2WPKH
  const AMOUNT = 10_000_000_000_000_000n; // 0.01 ETH

  console.log("Fetching quote: 0.01 ETH → BTC...");
  const quote = await bridge.quoteBridge({
    targetChain: "bitcoin",
    recipient: BTC_RECIPIENT,
    token: NATIVE_ETH,
    amount: AMOUNT,
  });

  console.log("Bridge quote:");
  console.log(`  Expected BTC out : ${quote.tokenOutAmount} sat`);
  console.log(`  Estimated fee    : ${quote.fee} wei`);
  console.log(`  Estimated time   : ${quote.estimatedTime}s`);
  console.log(`  Providers        : ${quote.providers?.join(", ")}`);

  // Uncomment to execute:
  // const result = await bridge.bridge({ targetChain: "bitcoin", recipient: BTC_RECIPIENT, token: NATIVE_ETH, amount: AMOUNT });
  // console.log(`  Tx hash          : ${result.hash}`);
}

// ---------------------------------------------------------------------------
// Example B: USDC → native ETH same-chain swap on Ethereum
//
// Chainflip lists ETH + USDC as quotable assets, so this pair resolves
// cleanly. USDC → WETH is *not* supported at v1.0 because Chainflip
// doesn't list WETH — use a DEX-based adapter when that arrives.
// ---------------------------------------------------------------------------

async function exampleSwap() {
  const account = await wdk.getAccount("ethereum", 0);
  const swapper = account.getSwapProtocol("swap-dk-swap");

  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const NATIVE_ETH_ADDR = "0x0000000000000000000000000000000000000000";
  const AMOUNT = 100_000_000n; // 100 USDC (6 decimals)

  console.log("Fetching quote: 100 USDC → native ETH...");
  const quote = await swapper.quoteSwap({
    tokenIn: USDC,
    tokenOut: NATIVE_ETH_ADDR,
    tokenInAmount: AMOUNT,
  });

  console.log("Swap quote:");
  console.log(`  Expected ETH out  : ${quote.tokenOutAmount} wei`);
  console.log(`  Estimated fee     : ${quote.fee} wei`);

  // Uncomment to execute:
  // const result = await swapper.swap({ tokenIn: USDC, tokenOut: NATIVE_ETH_ADDR, tokenInAmount: AMOUNT });
  // console.log(`  Tx hash           : ${result.hash}`);
  // console.log(`  Approve tx        : ${result.approveHash ?? "n/a"}`);
}

async function main() {
  await exampleBridge();
  await exampleSwap();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
