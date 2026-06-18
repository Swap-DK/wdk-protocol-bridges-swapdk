// ---------------------------------------------------------------------------
// Cross-package known-token registry.
//
// Per swap-engine's wire contract, ERC-20 / SPL tokens are referenced by
// their canonical symbol (USDC, USDT, WETH, …). Address-only references
// like "ETH.ETH-0xAddress" get the address suffix stripped server-side
// and only the symbol is used for routing — so the symbol on the wire
// MUST be the real one. This registry maps `chain → address → { symbol,
// decimals }` so each consuming package can resolve a user's raw token
// address to the right canonical symbol before it ever reaches the
// engine.
//
// The shipped registry covers Solana SPL mints + the destination ERC-20s
// across every supported EVM chain. To add tokens at runtime call
// `registerToken` (validates the input synchronously).
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "./errors.js";

export interface KnownToken {
  symbol: string;
  decimals: number;
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Module-level registry. Mutable on purpose — `registerToken` extends it
 * at runtime, and that addition is visible to every package + every
 * bridge instance in the same process. Address keys are stored
 * lowercase for EVM (case-insensitive hex) and verbatim for Solana
 * (base58 is case-sensitive).
 */
export const KNOWN_TOKENS: Record<string, Record<string, KnownToken>> = {
  solana: {
    // USDC on Solana (Circle, canonical)
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
    // USDT on Solana (Tether, canonical)
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
    // Wrapped SOL — exposed if user deliberately wraps before a swap
    "So11111111111111111111111111111111111111112": { symbol: "SOL",  decimals: 9 },
  },
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { symbol: "WBTC", decimals: 8 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI",  decimals: 18 },
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC", decimals: 6 }, // bridged USDC.e
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18 },
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { symbol: "WBTC", decimals: 8 },
  },
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  },
  bsc: {
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC", decimals: 18 },
    "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT", decimals: 18 },
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { symbol: "WBNB", decimals: 18 },
  },
  avalanche: {
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { symbol: "USDC", decimals: 6 },
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": { symbol: "USDT", decimals: 6 },
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { symbol: "WAVAX", decimals: 18 },
  },
  optimism: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6 },
    "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { symbol: "USDC", decimals: 6 }, // bridged USDC.e
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC", decimals: 6 }, // bridged USDC.e
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WMATIC", decimals: 18 },
  },
};

/**
 * Look up a token by chain + address. Returns undefined when the address
 * is not in the registry.
 *
 * Address matching:
 * - EVM (`0x…`): case-insensitive hex; keys are stored lowercase.
 * - Solana (base58): case-sensitive verbatim match.
 */
export function lookupToken(chain: string, address: string): KnownToken | undefined {
  const chainMap = KNOWN_TOKENS[chain.toLowerCase()];
  if (!chainMap) return undefined;
  if (/^0x/i.test(address)) {
    return chainMap[address.toLowerCase()];
  }
  return chainMap[address];
}

/**
 * Register a token at runtime. Use for tokens that aren't shipped in
 * the registry. Validates address format (EVM 0x + 40 hex, or Solana
 * base58 32–44 chars), symbol non-empty, decimals integer in [0, 77].
 *
 * @throws {SwapDKUserError} on invalid input.
 *
 * @example
 *   // Solana SPL: PYTH token
 *   registerToken("solana", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
 *     { symbol: "PYTH", decimals: 6 });
 *
 *   // EVM ERC-20: FRAX on Ethereum
 *   registerToken("ethereum", "0x853d955acef822db058eb8505911ed77f175b99e",
 *     { symbol: "FRAX", decimals: 18 });
 *
 * Note: a successful registration does not guarantee that the upstream
 * provider (Chainflip / THORChain / MAYAChain) actually lists the
 * token — swap-engine may still return "no routes" for unsupported
 * pairs.
 */
export function registerToken(
  chain: string,
  address: string,
  info: KnownToken,
): void {
  const chainKey = chain.toLowerCase();
  const looksHex = /^0x/i.test(address);
  const addrNormalized = looksHex ? address.toLowerCase() : address;

  const evmValid = /^0x[0-9a-f]{40}$/.test(addrNormalized);
  const solanaValid = !looksHex && SOLANA_PUBKEY_RE.test(address);

  if (!evmValid && !solanaValid) {
    throw new SwapDKUserError(
      `registerToken: invalid address "${address}" — expected EVM 0x + 40-hex or Solana base58 (32–44 chars).`,
    );
  }
  const symbol = String(info.symbol).trim();
  if (!symbol) {
    throw new SwapDKUserError(`registerToken: symbol is required.`);
  }
  if (
    !Number.isInteger(info.decimals) ||
    info.decimals < 0 ||
    info.decimals > 77
  ) {
    throw new SwapDKUserError(
      `registerToken: decimals must be a non-negative integer ≤ 77, got ${info.decimals}.`,
    );
  }

  if (!KNOWN_TOKENS[chainKey]) {
    KNOWN_TOKENS[chainKey] = {};
  }
  KNOWN_TOKENS[chainKey][addrNormalized] = {
    symbol: symbol.toUpperCase(),
    decimals: info.decimals,
  };
}

/**
 * Best-effort check that a string looks like a Solana base58 pubkey.
 * Used for input validation; the authoritative check is via
 * `@solana/addresses`' `address()` at transaction build time.
 */
export function isLikelySolanaAddress(s: string): boolean {
  return SOLANA_PUBKEY_RE.test(s);
}
