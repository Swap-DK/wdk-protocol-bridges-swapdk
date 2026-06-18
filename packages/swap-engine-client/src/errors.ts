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

/** HTTP error returned by the swap-engine API, or a response-shape mismatch
 * caught by zod parsing on the client side. `errorCode` carries the
 * server-emitted code (`swap_amount_below_min`, `track_not_found`, etc.) for
 * upstream errors; for client-side schema mismatches it is set to
 * `"response_schema_mismatch"` and `cause` holds the `ZodError`. */
export class SwapDKApiError extends SwapDKError {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly errorCode?: string,
    message?: string,
    cause?: unknown,
  ) {
    super(
      `SwapDK API error ${status} on ${path}` +
      (errorCode ? ` [${errorCode}]` : "") +
      (message ? `: ${message}` : ""),
    );
    if (cause !== undefined) {
      this.cause = cause;
    }
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
   * True when swap-engine rejected the request because `sellAmount` is
   * below the upstream protocol's minimum. Matches all three places
   * the minimum-deposit gate fires:
   *   - `/swap` + `swap_amount_below_min` — the chosen route's amount
   *     fell below THORChain/MAYAChain `recommended_min_amount_in`
   *     between `/quote` and `/swap`. Original case (the "silent 200
   *     with empty memo" fix).
   *   - `/quote` + `quote_amount_below_min` — Chainflip's broker
   *     minimum_deposit_amount rejected the request upfront, and no
   *     other provider had a usable route. Critical because Chainflip
   *     does NOT refund sub-minimum deposits — surfacing this before
   *     `bridge()` is the only safety net.
   *   - `/chainflip/broker/channel` + `broker_channel_amount_below_min`
   *     — caller went straight to channel allocation (or stale-route
   *     retry brought us back here without a fresh /quote) with a
   *     sub-minimum sellAmount; swap-engine refuses to open the
   *     channel. Same user-actionable condition as above.
   *
   * Client-actionable: the typical UX is to display the upstream
   * `message` (which contains the per-provider minimum) and let the
   * user retry with a higher amount.
   */
  get isAmountBelowMin(): boolean {
    if (this.status !== 422) return false;
    if (this.path === "/swap"  && this.errorCode === "swap_amount_below_min")  return true;
    if (this.path === "/quote" && this.errorCode === "quote_amount_below_min") return true;
    if (this.path === "/chainflip/broker/channel" &&
        this.errorCode === "broker_channel_amount_below_min") return true;
    return false;
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
