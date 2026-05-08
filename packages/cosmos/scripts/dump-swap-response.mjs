#!/usr/bin/env node
/**
 * One-shot debug helper: hits POST /quote then POST /swap on a live
 * swap-engine and dumps the raw JSON of both responses, plus a focused
 * summary of the fields the cosmos bridge consumes (memo, sellAsset,
 * sellAmount, inboundAddress, targetAddress, tx).
 *
 * Use this when readonly-smoke.mjs reports an unexpected response shape
 * and you need to see what swap-engine actually returned.
 *
 * Required env vars:
 *   SWAP_ENGINE_URL       https://api.swapdk.com
 *   SWAP_ENGINE_KEY       SwapDK API key
 *   SOURCE_ADDRESS        bech32 source-chain address
 *   DESTINATION_ADDRESS   destination-chain address
 *
 * Optional:
 *   SOURCE_CHAIN          thorchain | mayachain        (default: thorchain)
 *   TARGET_CHAIN          bitcoin / ethereum / …       (default: bitcoin)
 *   SELL_AMOUNT           human-decimal string         (default: "1")
 *   BUY_ASSET             SwapKit string               (default: native of TARGET_CHAIN)
 */

const URL = (process.env.SWAP_ENGINE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.SWAP_ENGINE_KEY ?? "";
const SOURCE_ADDRESS = process.env.SOURCE_ADDRESS ?? "";
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS ?? "";
const SOURCE_CHAIN = (process.env.SOURCE_CHAIN ?? "thorchain").toLowerCase();
const TARGET_CHAIN = (process.env.TARGET_CHAIN ?? "bitcoin").toLowerCase();
const SELL_AMOUNT = process.env.SELL_AMOUNT ?? "1";

const NATIVE_BY_CHAIN = {
  bitcoin: "BTC.BTC",
  ethereum: "ETH.ETH",
  arbitrum: "ARB.ETH",
  base: "BASE.ETH",
  bsc: "BSC.BNB",
  avalanche: "AVAX.AVAX",
  optimism: "OP.ETH",
  polygon: "MATIC.MATIC",
  litecoin: "LTC.LTC",
  dogecoin: "DOGE.DOGE",
  tron: "TRON.TRX",
};
const SELL_ASSET = SOURCE_CHAIN === "mayachain" ? "MAYA.CACAO" : "THOR.RUNE";
const BUY_ASSET = process.env.BUY_ASSET ?? NATIVE_BY_CHAIN[TARGET_CHAIN];

const missing = [];
if (!URL) missing.push("SWAP_ENGINE_URL");
if (!KEY) missing.push("SWAP_ENGINE_KEY");
if (!SOURCE_ADDRESS) missing.push("SOURCE_ADDRESS");
if (!DESTINATION_ADDRESS) missing.push("DESTINATION_ADDRESS");
if (!BUY_ASSET) missing.push("BUY_ASSET (no default for TARGET_CHAIN=" + TARGET_CHAIN + ")");
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(`${URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

function divider(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

// 1. /quote ---------------------------------------------------------------

divider(`POST /quote  ${SELL_ASSET} → ${BUY_ASSET}  (${SELL_AMOUNT})`);

const quote = await post("/quote", {
  sellAsset: SELL_ASSET,
  buyAsset: BUY_ASSET,
  sellAmount: SELL_AMOUNT,
  sourceAddress: SOURCE_ADDRESS,
  destinationAddress: DESTINATION_ADDRESS,
  slippage: 300,
  includeTx: false,
});

console.log("status:", quote.status);
console.log("body:");
console.log(JSON.stringify(quote.body, null, 2));

if (!quote.ok) process.exit(1);
const routes = quote.body.routes ?? [];
if (routes.length === 0) {
  console.log("\n(no routes — nothing to /swap against)");
  process.exit(0);
}

// Iterate every route and /swap each so we see the response shape per
// provider. swap-engine returns multiple routes (THORChain + MAYAChain
// for RUNE→BTC); /quote alone doesn't reveal the per-provider memo /
// inboundAddress / tx layout — only /swap does.

for (let i = 0; i < routes.length; i++) {
  const route = routes[i];
  const tag = route.providers?.join(",") ?? "?";
  divider(`Route ${i + 1}/${routes.length} — providers: ${tag}`);
  console.log("routeId:           ", route.routeId);
  console.log("expectedBuyAmount: ", route.expectedBuyAmount);
  console.log("memo (in /quote):  ", JSON.stringify(route.memo));
  console.log("inboundAddress:    ", JSON.stringify(route.inboundAddress));
  console.log("targetAddress:     ", JSON.stringify(route.targetAddress));
  console.log("approvalAddress:   ", JSON.stringify(route.approvalAddress));
  console.log("expiration:        ", route.expiration);

  divider(`  POST /swap [${tag}]`);
  const swap = await post("/swap", {
    routeId: route.routeId,
    sourceAddress: SOURCE_ADDRESS,
    destinationAddress: DESTINATION_ADDRESS,
  });
  console.log(`  status: ${swap.status}`);

  if (!swap.ok) {
    console.log("  body:");
    console.log(JSON.stringify(swap.body, null, 2));
    continue;
  }

  console.log("  body:");
  console.log(JSON.stringify(swap.body, null, 2));

  console.log(`\n  --- field summary for ${tag} ---`);
  const r = swap.body;
  const lines = [
    ["sellAsset", r.sellAsset],
    ["sellAmount", r.sellAmount],
    ["buyAsset", r.buyAsset],
    ["buyAmount", r.buyAmount],
    ["memo", r.memo],
    ["targetAddress", r.targetAddress],
    ["inboundAddress", r.inboundAddress],
    ["providers", JSON.stringify(r.providers)],
    ["fees.length", (r.fees ?? []).length],
    ["tx (present?)", r.tx !== undefined ? "yes" : "no"],
    ["approvalTx (present?)", r.approvalTx !== undefined ? "yes" : "no"],
  ];
  for (const [k, v] of lines) console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);

  if (r.tx) {
    console.log(`\n  --- nested tx ---`);
    console.log(JSON.stringify(r.tx, null, 2));
  }
}
