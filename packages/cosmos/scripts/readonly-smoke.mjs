#!/usr/bin/env node
/**
 * Read-only integration smoke test against a live swap-engine instance.
 *
 * Hits /quote and /swap for a THOR.RUNE → BTC.BTC (or configurable) route,
 * runs the response through SwapDKBridgeCosmos with a stub wallet that
 * captures the deposit arguments instead of broadcasting. Verifies the
 * shape of swap-engine's responses matches what bridge() expects.
 *
 * No on-chain transactions are sent. Safe to re-run.
 *
 * Prerequisites:
 *   - npm run build (so dist/ exists for this script to import)
 *
 * Required env vars:
 *   SWAP_ENGINE_URL       https://api.swapdk.com
 *   SWAP_ENGINE_KEY       SwapDK API key
 *   SOURCE_ADDRESS        Source-chain address (bech32 — thor1… / maya1…)
 *   DESTINATION_ADDRESS   Destination-chain address
 *
 * Optional env vars:
 *   SOURCE_CHAIN     thorchain | mayachain        (default: thorchain)
 *   TARGET_CHAIN     bitcoin / ethereum / …        (default: bitcoin)
 *   TOKEN_OUT        SwapKit asset string          (default: native of TARGET_CHAIN)
 *   SELL_AMOUNT      base units, bigint string     (default: 1 RUNE / 1 CACAO)
 */

import { SwapDKBridgeCosmos } from "../dist/index.js";

// --- Env ---------------------------------------------------------------------

const URL = (process.env.SWAP_ENGINE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.SWAP_ENGINE_KEY ?? "";
const SOURCE_ADDRESS = process.env.SOURCE_ADDRESS ?? "";
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS ?? "";
const SOURCE_CHAIN = (process.env.SOURCE_CHAIN ?? "thorchain").toLowerCase();
const TARGET_CHAIN = (process.env.TARGET_CHAIN ?? "bitcoin").toLowerCase();
const TOKEN_OUT = process.env.TOKEN_OUT;

const DEFAULT_AMOUNT = SOURCE_CHAIN === "mayachain" ? 10_000_000_000n : 100_000_000n;
const SELL_AMOUNT = process.env.SELL_AMOUNT
  ? BigInt(process.env.SELL_AMOUNT)
  : DEFAULT_AMOUNT;

const missing = [];
if (!URL) missing.push("SWAP_ENGINE_URL");
if (!KEY) missing.push("SWAP_ENGINE_KEY");
if (!SOURCE_ADDRESS) missing.push("SOURCE_ADDRESS");
if (!DESTINATION_ADDRESS) missing.push("DESTINATION_ADDRESS");
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// --- Stub wallet -------------------------------------------------------------

let capturedDeposit = null;

const stubWallet = {
  getAddress: () => SOURCE_ADDRESS,
  deposit: async (options) => {
    // Capture rather than broadcast — this is the read-only smoke test.
    capturedDeposit = options;
    return { hash: "DRY-RUN-NOT-BROADCAST", fee: 0n };
  },
};

// --- Run ---------------------------------------------------------------------

const bridge = new SwapDKBridgeCosmos(stubWallet, {
  apiUrl: URL,
  apiKey: KEY,
  retries: 0,
});
bridge.setSourceChain(SOURCE_CHAIN);

console.log(`source       ${SOURCE_CHAIN} (${SOURCE_ADDRESS})`);
console.log(`target       ${TARGET_CHAIN} (${DESTINATION_ADDRESS})`);
console.log(`tokenOut     ${TOKEN_OUT ?? "(default native)"}`);
console.log(`sellAmount   ${SELL_AMOUNT.toString()} base units`);
console.log("");

let passed = 0;
const checks = [];

function expect(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (ok) passed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // 1. quoteBridge — read-only.
  console.log("1/2  quoteBridge");
  const quote = await bridge.quoteBridge({
    token: "native",
    amount: SELL_AMOUNT,
    targetChain: TARGET_CHAIN,
    tokenOut: TOKEN_OUT,
    recipient: DESTINATION_ADDRESS,
  });

  expect(
    "tokenInAmount round-trips through fromHumanDecimal",
    quote.tokenInAmount === SELL_AMOUNT,
    `expected ${SELL_AMOUNT}, got ${quote.tokenInAmount}`,
  );
  expect(
    "tokenOutAmount > 0",
    quote.tokenOutAmount > 0n,
    `${quote.tokenOutAmount}`,
  );
  expect(
    "providers populated",
    Array.isArray(quote.providers) && quote.providers.length > 0,
    quote.providers?.join(","),
  );
  expect(
    "estimatedTime is a positive number",
    typeof quote.estimatedTime === "number" && quote.estimatedTime > 0,
    `${quote.estimatedTime}s`,
  );
  expect(
    "fee is 0n on quote (no source-tx gas estimate)",
    quote.fee === 0n,
  );
  expect(
    "bridgeFee is parseable bigint",
    typeof quote.bridgeFee === "bigint",
    `${quote.bridgeFee} (base units of source)`,
  );

  console.log("");

  // 2. bridge — stub-wallet captures the deposit args without broadcasting.
  console.log("2/2  bridge (stub wallet — no broadcast)");
  const result = await bridge.bridge({
    token: "native",
    amount: SELL_AMOUNT,
    targetChain: TARGET_CHAIN,
    tokenOut: TOKEN_OUT,
    recipient: DESTINATION_ADDRESS,
  });

  expect(
    "wallet.deposit() was called",
    capturedDeposit !== null,
  );
  expect(
    `asset is ${SOURCE_CHAIN === "mayachain" ? "MAYA.CACAO" : "THOR.RUNE"}`,
    capturedDeposit?.asset ===
      (SOURCE_CHAIN === "mayachain" ? "MAYA.CACAO" : "THOR.RUNE"),
    capturedDeposit?.asset,
  );
  expect(
    "amount matches the requested sell amount",
    capturedDeposit?.amount === SELL_AMOUNT,
    `${capturedDeposit?.amount}`,
  );
  expect(
    "memo is non-empty",
    typeof capturedDeposit?.memo === "string" && capturedDeposit.memo.length > 0,
    capturedDeposit?.memo
      ? `"${capturedDeposit.memo.slice(0, 60)}${capturedDeposit.memo.length > 60 ? "…" : ""}"`
      : "(empty)",
  );
  expect(
    "memo references the destination address",
    capturedDeposit?.memo?.includes(DESTINATION_ADDRESS),
    capturedDeposit?.memo?.includes(DESTINATION_ADDRESS) ? "ok" : "destination not in memo",
  );
  expect(
    "result.hash is the stub sentinel (no broadcast happened)",
    result.hash === "DRY-RUN-NOT-BROADCAST",
  );

  console.log("");

  const total = checks.length;
  console.log(`${passed}/${total} checks passed`);
  if (passed < total) process.exit(1);
} catch (err) {
  console.error("");
  console.error(`SMOKE FAILED: ${err.message}`);
  if (err.providerErrors) {
    console.error("Provider errors:");
    for (const p of err.providerErrors) {
      console.error(`  ${p.provider}: ${p.message}`);
    }
  }
  process.exit(1);
}
