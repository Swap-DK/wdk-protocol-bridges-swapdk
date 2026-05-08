// ---------------------------------------------------------------------------
// Helpers shared between SwapDKBridgeEvm (cross-chain) and SwapDKSwapEvm
// (same-chain). Not part of the public surface — purposely small so the
// two modules can keep their respective bridge() / swap() flows readable.
// ---------------------------------------------------------------------------

/**
 * Some WDK EVM wallet implementations (`@tetherto/wdk-wallet-evm`,
 * ethers-derived stacks) return a TransactionResponse-like object from
 * `sendTransaction`; others return the hex hash string directly. Pull
 * the canonical hash from either shape.
 */
export function txHash(result: string | { hash: string }): string {
  return typeof result === "string" ? result : result.hash;
}

/**
 * Compute estimated tx fee in wei from a `tx` payload (gas × gasPrice).
 * Falls back to gas alone if gasPrice is missing — older swap-engine
 * responses or non-EIP-1559 chains may omit it. A `0n` result means
 * "no estimate available".
 */
export function estimateFeeWei(
  tx: { gas?: string; gasPrice?: string } | undefined,
): bigint {
  if (!tx?.gas) return 0n;
  const gas = BigInt(tx.gas);
  if (!tx.gasPrice) return gas; // legacy fallback; treat as gas units only
  return gas * BigInt(tx.gasPrice);
}
