#!/usr/bin/env node
/**
 * Minimal integration smoke test against a live swap-engine instance.
 *
 * Read-only — no wallet, no seed phrase, no broadcasts.
 *
 * Required env vars:
 *   SWAP_ENGINE_URL  e.g. https://api.swapdk.com
 *   SWAP_ENGINE_KEY  SwapDK API key
 *
 * Verifies that:
 *   1. SOL.SOL → ETH.ETH quote returns a THORChain route with
 *      inboundAddress + memo (the deposit-channel data this module
 *      relies on for Solana source).
 *   2. SOL.USDC → ETH.ETH quote at least returns a route, even if it's
 *      currently CHAINFLIP-routed and not yet executable from the client
 *      (SPL-source flow + Chainflip non-EVM /swap support pending).
 *      We assert only that the contract is reachable — i.e. routes is
 *      non-empty — to fail loudly if swap-engine ever stops accepting
 *      the bare `SOL.USDC` notation we use.
 */

const BASE = (process.env.SWAP_ENGINE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.SWAP_ENGINE_KEY ?? "";

if (!BASE || !KEY) {
  console.error("Error: SWAP_ENGINE_URL and SWAP_ENGINE_KEY must be set.");
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const SOL_SAMPLE_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ETH_SAMPLE_ADDR = "0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54";

async function run() {
  let passed = 0;

  // 1. Native SOL → ETH (THORChain): expect inboundAddress + memo.
  process.stdout.write("1/2  POST /quote SOL.SOL → ETH.ETH ... ");
  const q1 = await post("/quote", {
    sellAsset: "SOL.SOL",
    buyAsset: "ETH.ETH",
    sellAmount: "1",
    sourceAddress: SOL_SAMPLE_ADDR,
    destinationAddress: ETH_SAMPLE_ADDR,
    slippage: 300,
    includeTx: false,
  });
  if (!Array.isArray(q1.routes) || q1.routes.length === 0) {
    const errs = (q1.providerErrors ?? []).map((e) => `${e.provider}: ${e.message}`).join("; ");
    throw new Error(`No routes returned. ${errs}`);
  }
  const r1 = q1.routes.find((r) => r.inboundAddress && r.memo) ?? q1.routes[0];
  if (!r1.inboundAddress || !r1.memo) {
    throw new Error(`SOL.SOL route missing inboundAddress/memo (provider=${r1.providers?.join(",")})`);
  }
  console.log(`OK (provider=${r1.providers.join(",")}, memo=${r1.memo.slice(0, 24)}…)`);
  passed++;

  // 2. SOL.USDC → ETH (currently CHAINFLIP-routed): assert routes are
  //    non-empty so we notice if the bare SOL.USDC notation stops working.
  process.stdout.write("2/2  POST /quote SOL.USDC → ETH.ETH ... ");
  const q2 = await post("/quote", {
    sellAsset: "SOL.USDC",
    buyAsset: "ETH.ETH",
    sellAmount: "100",
    sourceAddress: SOL_SAMPLE_ADDR,
    destinationAddress: ETH_SAMPLE_ADDR,
    slippage: 300,
    includeTx: false,
  });
  if (!Array.isArray(q2.routes) || q2.routes.length === 0) {
    const errs = (q2.providerErrors ?? []).map((e) => `${e.provider}: ${e.message}`).join("; ");
    throw new Error(`No routes returned. ${errs}`);
  }
  console.log(`OK (${q2.routes.length} route(s), best: ${q2.routes[0].providers.join(",")})`);
  passed++;

  console.log(`\nSmoke test passed — ${passed}/2 checks OK`);
}

run().catch((err) => {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  process.exit(1);
});
