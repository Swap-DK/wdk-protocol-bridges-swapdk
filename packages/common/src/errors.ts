// ---------------------------------------------------------------------------
// Typed error classes for SwapDK bridge module.
// ---------------------------------------------------------------------------

/** Base class for all SwapDK errors. */
export class SwapDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Network-level error: request timeout, DNS failure, connection refused. */
export class SwapDKNetworkError extends SwapDKError {
  constructor(path: string, cause?: unknown) {
    super(
      `Network error calling ${path}` +
      (cause instanceof Error ? `: ${cause.message}` : ""),
    );
    this.cause = cause;
  }
}

/** HTTP error returned by the swap-engine API. */
export class SwapDKApiError extends SwapDKError {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly errorCode?: string,
    message?: string,
  ) {
    super(
      `SwapDK API error ${status} on ${path}` +
      (errorCode ? ` [${errorCode}]` : "") +
      (message ? `: ${message}` : ""),
    );
  }

  /**
   * True when the error indicates a stale or expired routeId —
   * the caller may re-quote and retry.
   *
   * NOTE: This is only checked against errors from POST /swap, so a 404
   * here reliably means "routeId not found" rather than "endpoint not found".
   * 410 = Gone (route definitively expired); STALE_ROUTE / ROUTE_NOT_FOUND
   * are explicit error codes from swap-engine.
   */
  get isStaleRoute(): boolean {
    return (
      this.path === "/swap" &&
      (this.status === 404 ||
        this.status === 410 ||
        this.errorCode === "STALE_ROUTE" ||
        this.errorCode === "ROUTE_NOT_FOUND")
    );
  }

  /**
   * True when the error is `/track` responding "hash not found in
   * Midgard" — the caller may retry later or surface a "not found"
   * state to the user. Distinguishes from 502 which is a genuine
   * upstream failure (retry with backoff).
   */
  get isNotFound(): boolean {
    return (
      this.path === "/track" &&
      this.status === 404 &&
      this.errorCode === "track_not_found"
    );
  }

  /**
   * True when `/swap` responded that the routeId references a provider
   * not handled by the active swap engine (today: any CHAINFLIP routeId,
   * because the deposit-channel flow for non-EVM Chainflip sources
   * isn't implemented in swap-engine's `ThorMayaSwapEngine`).
   *
   * This is a client-actionable condition rather than an upstream
   * failure: the caller should re-quote with a different provider/pair
   * (or surface the limitation in the UI), not retry with backoff.
   */
  get isProviderUnsupported(): boolean {
    return (
      this.path === "/swap" &&
      this.status === 422 &&
      this.errorCode === "swapProviderUnsupported"
    );
  }

  /**
   * True when `/swap` responded that the chosen route's `sellAmount` is
   * below the upstream protocol's `recommended_min_amount_in`. This is
   * the structured form of the previous "silent 200 with empty memo"
   * degradation (fixed in swap-engine) — surfacing it as 422 lets a
   * caller prompt the user for a larger amount instead of broadcasting
   * a malformed tx.
   *
   * Client-actionable: the typical UX is to display the upstream
   * `message` (which contains the per-provider minimum) and let the
   * user retry with a higher amount.
   */
  get isAmountBelowMin(): boolean {
    return (
      this.path === "/swap" &&
      this.status === 422 &&
      this.errorCode === "swap_amount_below_min"
    );
  }

  /**
   * True when `/swap` rejected the request because the upstream protocol
   * could not validate an affiliate parameter (typically a missing or
   * unregistered mayaname / bech32 address in the swap-engine deployment's
   * affiliate config or in the API key's metadata).
   *
   * Operator-actionable, not user-actionable: the deployment's affiliate
   * configuration needs fixing. UIs should surface this as a server-side
   * misconfiguration rather than a user input error.
   */
  get isInvalidAffiliate(): boolean {
    return (
      this.path === "/swap" &&
      this.status === 422 &&
      this.errorCode === "swap_invalid_affiliate"
    );
  }

  /**
   * True when `/swap` rejected the request because the upstream protocol
   * reported the route as unavailable (halted pool, missing pool, etc.).
   *
   * Client-actionable: re-quote with a different asset pair, or wait
   * and retry if the condition is transient (pool resumes).
   */
  get isRouteUnavailable(): boolean {
    return (
      this.path === "/swap" &&
      this.status === 422 &&
      this.errorCode === "swap_route_unavailable"
    );
  }

  /**
   * True when `/swap` was rejected by the upstream protocol with an
   * error that swap-engine could not classify into a more specific
   * condition (catch-all). The free-form upstream message is preserved
   * in `this.message`.
   *
   * Action depends on the upstream message — this getter is mainly
   * useful as a fallback discriminator alongside the more specific
   * `isAmountBelowMin` / `isInvalidAffiliate` / `isRouteUnavailable`
   * helpers.
   */
  get isUpstreamRejected(): boolean {
    return (
      this.path === "/swap" &&
      this.status === 422 &&
      this.errorCode === "swap_upstream_rejected"
    );
  }
}

/**
 * Swap-engine returned no usable routes.
 * Contains per-provider error details for debugging.
 */
export class SwapDKProviderError extends SwapDKError {
  constructor(
    public readonly sellAsset: string,
    public readonly buyAsset: string,
    public readonly providerErrors: ReadonlyArray<{
      provider: string;
      message: string;
    }>,
  ) {
    const details = providerErrors
      .map((e) => `${e.provider}: ${e.message}`)
      .join("; ");
    super(
      `No routes found for ${sellAsset} → ${buyAsset}` +
      (details ? `. Provider errors: ${details}` : ""),
    );
  }
}

/**
 * User-actionable error: invalid configuration or a safety limit was
 * exceeded (e.g. estimated fee exceeds `bridgeMaxFee`).
 */
export class SwapDKUserError extends SwapDKError {}
