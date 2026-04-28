#!/usr/bin/env node
/**
 * Minimal integration smoke test against a live swap-engine instance.
 *
 * Does NOT require a wallet or seed phrase — only read operations (no txs).
 *
 * Required env vars:
 *   SWAP_ENGINE_URL  e.g. https://api.swapdk.com
 *   SWAP_ENGINE_KEY  SwapDK API key
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

async function run() {
  let passed = 0;

  // 1. Quote ETH → BTC (cross-chain bridge).
  // Amounts are human-decimal strings per the swap-engine contract.
  process.stdout.write("1/2  POST /quote ETH.ETH → BTC.BTC ... ");
  const q1 = await post("/quote", {
    sellAsset: "ETH.ETH",
    buyAsset: "BTC.BTC",
    sellAmount: "0.01",
    includeTx: false,
  });
  if (!Array.isArray(q1.routes) || q1.routes.length === 0) {
    const errs = (q1.providerErrors ?? []).map((e) => `${e.provider}: ${e.message}`).join("; ");
    throw new Error(`No routes returned. ${errs}`);
  }
  console.log(`OK (${q1.routes.length} route(s), best: ${q1.routes[0].providers.join(",")})`);
  passed++;

  // 2. Quote USDC → native ETH (same-chain swap, verified to route via Chainflip)
  // Amounts are human-decimal per the swap-engine contract — matches what the
  // client sends after converting from WDK bigint via toHumanDecimal().
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  process.stdout.write(`2/2  POST /quote ETH.USDC-${USDC.slice(0, 10)}… → ETH.ETH ... `);
  const q2 = await post("/quote", {
    sellAsset: `ETH.USDC-${USDC}`,
    buyAsset: "ETH.ETH",
    sellAmount: "100",
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
