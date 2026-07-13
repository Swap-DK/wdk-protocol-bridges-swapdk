// ---------------------------------------------------------------------------
// Swidge chain identifier ↔ SwapKit-style chain code translation.
//
// The swap-engine `/quote` and `/swap` HTTP surface still speaks SwapKit
// notation (`"ETH.USDC-0x…"`, `"BTC.BTC"`, `"THOR.RUNE"`). The swidge protocol
// speaks lower-case swidge chain ids (`"ethereum"`, `"bitcoin"`, `"thorchain"`).
// This file is the single translation table.
//
// Order matters: the map is the source of truth for supported source chains.
// Adding a new chain here + wiring an adapter is enough to make the
// swidge module route it — the /chains discovery endpoint on swap-engine
// carries the same list on the backend.
// ---------------------------------------------------------------------------

/**
 * Ordered list of every swidge chain the module recognises. Kept as an
 * array of tuples so the same source of truth serves both lookup
 * directions.
 */
const CHAIN_TABLE: ReadonlyArray<{
  swidge: string;
  swapkit: string;
  family: "bitcoin" | "evm" | "cosmos" | "tron" | "solana";
  nativeSymbol: string;
  nativeDecimals: number;
}> = [
  { swidge: "bitcoin", swapkit: "BTC", family: "bitcoin", nativeSymbol: "BTC", nativeDecimals: 8 },
  { swidge: "ethereum", swapkit: "ETH", family: "evm", nativeSymbol: "ETH", nativeDecimals: 18 },
  { swidge: "arbitrum", swapkit: "ARB", family: "evm", nativeSymbol: "ETH", nativeDecimals: 18 },
  { swidge: "base", swapkit: "BASE", family: "evm", nativeSymbol: "ETH", nativeDecimals: 18 },
  { swidge: "bsc", swapkit: "BSC", family: "evm", nativeSymbol: "BNB", nativeDecimals: 18 },
  { swidge: "avalanche", swapkit: "AVAX", family: "evm", nativeSymbol: "AVAX", nativeDecimals: 18 },
  { swidge: "tron", swapkit: "TRON", family: "tron", nativeSymbol: "TRX", nativeDecimals: 6 },
  { swidge: "solana", swapkit: "SOL", family: "solana", nativeSymbol: "SOL", nativeDecimals: 9 },
  { swidge: "thorchain", swapkit: "THOR", family: "cosmos", nativeSymbol: "RUNE", nativeDecimals: 8 },
  { swidge: "mayachain", swapkit: "MAYA", family: "cosmos", nativeSymbol: "CACAO", nativeDecimals: 10 },
  { swidge: "cosmoshub", swapkit: "GAIA", family: "cosmos", nativeSymbol: "ATOM", nativeDecimals: 6 },
  { swidge: "dogecoin", swapkit: "DOGE", family: "bitcoin", nativeSymbol: "DOGE", nativeDecimals: 8 },
  { swidge: "bitcoincash", swapkit: "BCH", family: "bitcoin", nativeSymbol: "BCH", nativeDecimals: 8 },
  { swidge: "litecoin", swapkit: "LTC", family: "bitcoin", nativeSymbol: "LTC", nativeDecimals: 8 },
];

/**
 * Resolves a swidge chain id to the SwapKit chain code used by the
 * `/quote` and `/swap` HTTP surface. Case-insensitive. Returns `""`
 * when the swidge id is unknown — callers must check and surface a
 * user-facing error.
 */
export function swapkitChainFor(swidgeChain: string): string {
  const target = swidgeChain.trim().toLowerCase();
  for (const row of CHAIN_TABLE) {
    if (row.swidge === target) return row.swapkit;
  }
  return "";
}

/** Reverse lookup: SwapKit code → swidge id. Returns `""` when unknown. */
export function swidgeChainFor(swapkitChain: string): string {
  const target = swapkitChain.trim().toUpperCase();
  for (const row of CHAIN_TABLE) {
    if (row.swapkit === target) return row.swidge;
  }
  return "";
}

/** Chain family (used by the source-dispatch layer to pick an adapter). */
export function chainFamilyFor(
  swidgeChain: string,
): "bitcoin" | "evm" | "cosmos" | "tron" | "solana" | "" {
  const target = swidgeChain.trim().toLowerCase();
  for (const row of CHAIN_TABLE) {
    if (row.swidge === target) return row.family;
  }
  return "";
}

/**
 * Metadata for a chain's native gas coin — ticker + decimals. Used by
 * the option translator to convert between base-unit `fromTokenAmount`
 * and the human-decimal string the swap-engine expects on /quote.
 */
export function nativeMetaFor(
  swidgeChain: string,
): { symbol: string; decimals: number } | null {
  const target = swidgeChain.trim().toLowerCase();
  for (const row of CHAIN_TABLE) {
    if (row.swidge === target) {
      return { symbol: row.nativeSymbol, decimals: row.nativeDecimals };
    }
  }
  return null;
}

/** All swidge chain ids the module knows about — used by tests. */
export function allSwidgeChains(): string[] {
  return CHAIN_TABLE.map((r) => r.swidge);
}
