import type { QuoteRoute } from "./http-schemas.js";

/**
 * Pick the best route from a quote response.
 *
 * swap-engine can return multiple routes (one per provider) and does not
 * guarantee ordering. Some providers return a route with
 * `expectedBuyAmount: "0"` when they cannot quote — picking `routes[0]`
 * blindly would pass that through to the caller.
 *
 * Strategy: filter out routes with non-positive `expectedBuyAmount`,
 * then pick the one with the highest output. Returns `null` when no
 * usable route exists.
 */
export function pickBestRoute(routes: QuoteRoute[]): QuoteRoute | null {
  const usable = routes.filter((r) => {
    const n = parseFloat(r.expectedBuyAmount);
    return Number.isFinite(n) && n > 0;
  });
  if (usable.length === 0) return null;
  return usable.reduce((best, r) =>
    parseFloat(r.expectedBuyAmount) > parseFloat(best.expectedBuyAmount) ? r : best,
  );
}
