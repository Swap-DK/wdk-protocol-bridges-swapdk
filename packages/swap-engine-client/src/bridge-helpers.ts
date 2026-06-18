// ---------------------------------------------------------------------------
// Helpers shared by every per-chain SwapDKBridge implementation.
// Each helper was copy-pasted across packages/{btc,evm,cosmos,tron,solana}
// before this module existed; lifting them avoids drift (e.g. a status
// added to "completed/refunded/failed" in one package but not another).
// ---------------------------------------------------------------------------

import {
  fromHumanDecimal,
  NATIVE_SYMBOL,
  parseSwapKitAsset,
  prefixToWdkChain,
  wdkChainToPrefix,
} from "./asset-utils.js";
import { SwapDKUserError } from "./errors.js";

/** Shape of one entry in `QuoteRoute.fees` returned by swap-engine. */
export interface BridgeFee {
  type: string;
  amount: string;
  asset?: string;
}

/**
 * Track-status values that indicate the bridge has reached a final state
 * and polling should stop. Mirrors swap-engine's /track terminal set.
 */
export const TERMINAL_TRACK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "refunded",
  "failed",
]);

export function isTerminalTrackStatus(status: string): boolean {
  return TERMINAL_TRACK_STATUSES.has(status);
}

/**
 * Promise-based setTimeout. Used by every per-chain `waitForBridge` to
 * space `/track` polls.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the "PREFIX.SYMBOL" SwapKit asset string for the native asset
 * of `targetChain`. Used when the caller omits `tokenOut` — we default
 * to the destination chain's native (e.g. "BTC.BTC" for bitcoin,
 * "ETH.ETH" for ethereum).
 *
 * @throws {SwapDKUserError} when `targetChain` is unknown to the
 *         module's chain registry.
 */
/**
 * Validate and normalise a chain name a single-source bridge module
 * accepts via `setSourceChain(chain)`. Lower-cases the input, checks
 * it against the allowed set, and throws SwapDKUserError on mismatch
 * with a label-specific message. Returns the normalised value so the
 * caller can assign it to its `sourceChain` field in one shot.
 *
 * @example
 *   this.sourceChain = assertAllowedSourceChain(
 *     chain, new Set(["solana"]), "Solana",
 *   );
 *
 * @throws {SwapDKUserError} when `chain` lower-cased is not in
 *         `allowed`.
 */
export function assertAllowedSourceChain(
  chain: string,
  allowed: ReadonlySet<string>,
  label: string,
): string {
  const lower = chain.toLowerCase();
  if (!allowed.has(lower)) {
    const expected = [...allowed].map((c) => `"${c}"`).join(" or ");
    throw new SwapDKUserError(
      `Unsupported ${label} source chain: ${chain}. Expected ${expected}.`,
    );
  }
  return lower;
}

export function defaultBuyAsset(targetChain: string): string {
  const prefix = wdkChainToPrefix(targetChain);
  const symbol = NATIVE_SYMBOL[prefix];
  if (!symbol) {
    throw new SwapDKUserError(`No default buy asset for chain: ${targetChain}`);
  }
  return `${prefix}.${symbol}`;
}

/**
 * Asset string the first fee of a given type is denominated in, or
 * `undefined` when no fee of that type is present. Best-effort
 * companion to `sumFeesOfType` for callers that want to format the
 * summed value correctly.
 */
export function feeAssetOfType(
  fees: ReadonlyArray<BridgeFee>,
  feeType: string,
): string | undefined {
  const first = fees.find((f) => f.type === feeType);
  return first?.asset?.trim() || undefined;
}

/**
 * Resolve the WDK chain name a fee asset belongs to. Parses the SwapKit
 * `PREFIX.SYMBOL` prefix and maps it to a chain registry key. Fee
 * assets can legitimately live on a different chain than the bridge's
 * source (e.g. a Chainflip USDC liquidity fee on a BTC→ETH route is
 * `"ETH.USDC-…"`), so we prefer the asset's own chain to `sourceChain`
 * when available — otherwise the caller's source chain is the fallback.
 */
function feeChainFromAsset(
  asset: string | undefined,
  sourceChain: string,
): string {
  if (!asset) return sourceChain;
  const parsed = parseSwapKitAsset(asset);
  if (!parsed?.chain) return sourceChain;
  try {
    return prefixToWdkChain(parsed.chain);
  } catch {
    // Unknown prefix — fall back to the source chain's resolver.
    return sourceChain;
  }
}

/**
 * Sum the fees of `feeType` in `route.fees`, best-effort. swap-engine
 * returns human-decimal strings tagged with a SwapKit asset; we resolve
 * decimals via the asset's own chain (so cross-chain fees like
 * "ETH.USDC-…" on a non-ETH route don't get the wrong decimal count
 * inferred from the source chain), falling back to the caller's source
 * chain when the asset prefix doesn't parse.
 *
 * Unparseable entries are skipped — the returned sum is informational
 * (UI display), not consensus-critical.
 */
export function sumFeesOfType(
  fees: ReadonlyArray<BridgeFee>,
  feeType: string,
  opts: {
    /** Per-package decimals resolver (e.g. evmBridge.resolveAssetDecimals). */
    resolveDecimals: (chain: string, asset: string | undefined) => number;
    /** WDK chain the bridge was registered for (fallback context). */
    sourceChain: string;
    /** Used when the per-asset chain can't be resolved (typically the source chain's native precision). */
    fallbackDecimals: number;
  },
): bigint {
  return fees
    .filter((f) => f.type === feeType)
    .reduce((sum, f) => {
      const chain = feeChainFromAsset(f.asset, opts.sourceChain);
      let decimals: number;
      try {
        decimals = opts.resolveDecimals(chain, f.asset);
      } catch {
        decimals = opts.fallbackDecimals;
      }
      try {
        return sum + fromHumanDecimal(f.amount, decimals);
      } catch {
        return sum;
      }
    }, 0n);
}
