/**
 * Minimal WDK app scaffold demonstrating how to register and use
 * SwapDKBridgeSolana as a WDK bridge protocol module.
 *
 * Prerequisites:
 *   npm install @tetherto/wdk @tetherto/wdk-wallet-solana \
 *               @swapdk/wdk-protocol-bridge-swapdk-solana
 *
 * Run:
 *   npx tsx examples/wdk-app.ts
 */

import WDK from "@tetherto/wdk";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";
import { SwapDKBridgeSolana } from "@swapdk/wdk-protocol-bridge-swapdk-solana";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEED_PHRASE = process.env.SEED_PHRASE ?? "";
const SWAP_ENGINE_URL = process.env.SWAP_ENGINE_URL ?? "https://api.swapdk.com";
const SWAP_ENGINE_KEY = process.env.SWAP_ENGINE_KEY ?? "";
const SOL_RPC_URL = process.env.SOL_RPC_URL ?? "https://api.mainnet-beta.solana.com";

if (!SEED_PHRASE || !SWAP_ENGINE_KEY) {
  console.error("Required env vars: SEED_PHRASE, SWAP_ENGINE_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WDK setup — register the Solana wallet and SwapDK bridge protocol
// ---------------------------------------------------------------------------

const wdk = new WDK(SEED_PHRASE)
  .registerWallet("solana", WalletManagerSolana, {
    rpcUrl: SOL_RPC_URL,
  })
  .registerProtocol("solana", "swap-dk-bridge", SwapDKBridgeSolana, {
    apiUrl: SWAP_ENGINE_URL,
    apiKey: SWAP_ENGINE_KEY,
    slippageBps: 300,                // 3 %
    bridgeMaxFee: 100_000n,          // 100_000 lamports safety cap
  });

// ---------------------------------------------------------------------------
// Example: 1 SOL → native ETH on Ethereum via THORChain
// ---------------------------------------------------------------------------

async function main() {
  const account = await wdk.getAccount("solana", 0);
  const bridge = account.getBridgeProtocol("swap-dk-bridge");

  const NATIVE_SOL = "";                                         // empty = native SOL
  const ETH_RECIPIENT = "0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54";
  const AMOUNT = 1_000_000_000n;                                 // 1 SOL in lamports

  console.log("Fetching quote: 1 SOL → native ETH on Ethereum...");
  const quote = await bridge.quoteBridge({
    targetChain: "ethereum",
    recipient:   ETH_RECIPIENT,
    token:       NATIVE_SOL,
    amount:      AMOUNT,
  });

  console.log("Bridge quote:");
  console.log(`  Expected ETH out : ${quote.tokenOutAmount} wei`);
  console.log(`  Providers        : ${quote.providers?.join(", ")}`);
  console.log(`  Estimated time   : ${quote.estimatedTime}s`);
  console.log(`  Inbound vault    : ${quote.inboundAddress}`);
  console.log(`  Memo             : ${quote.memo}`);
  console.log(`  Expires at       : ${new Date((quote.expiration ?? 0) * 1000).toISOString()}`);

  // Uncomment to actually broadcast. Costs real SOL (tx fee) and moves the
  // input amount to the THORChain inbound vault; THORChain then delivers the
  // ETH to `ETH_RECIPIENT` after inbound/outbound settlement (~60 s total).
  //
  // const result = await bridge.bridge({
  //   targetChain: "ethereum",
  //   recipient:   ETH_RECIPIENT,
  //   token:       NATIVE_SOL,
  //   amount:      AMOUNT,
  // });
  // console.log(`  Solana tx hash  : ${result.hash}`);
  // console.log(`  Actual fee      : ${result.fee} lamports`);
  //
  // // Poll /track until the bridge finalises (or until we give up).
  // const final = await bridge.waitForBridge(result.hash, undefined, {
  //   pollIntervalMs: 5_000,
  //   timeoutMs:      600_000,
  //   onUpdate: (s) => console.log(`  [${s.status}] ${s.fromAmount} ${s.fromAsset} → ${s.toAmount} ${s.toAsset}`),
  // });
  // console.log(`  Final status    : ${final.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
