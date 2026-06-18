// ---------------------------------------------------------------------------
// HTTP client for the SwapDK swap-engine REST API.
//
// Every public method pairs its request with a zod schema for the response;
// the wire-level `request()` parses the body through `.safeParse()` before
// returning, throwing a `SwapDKApiError` with `errorCode:"response_schema_
// mismatch"` and `cause: ZodError` when the shape diverges. Upstream HTTP
// errors keep their existing classification path (`!res.ok` branch) and
// fall through to `SwapDKApiError(status, path, errorCode, message)`.
// ---------------------------------------------------------------------------

import type { z } from "zod";

import { sleep } from "./bridge-helpers.js";
import { SwapDKApiError, SwapDKNetworkError } from "./errors.js";
import {
  BrokerChannelResponseSchema,
  QuoteResponseSchema,
  SwapResponseSchema,
  TrackResponseSchema,
} from "./http-schemas.js";
import type {
  BrokerChannelRequest,
  BrokerChannelResponse,
  QuoteRequest,
  QuoteResponse,
  SwapRequest,
  SwapResponse,
  TrackRequest,
  TrackResponse,
} from "./http-schemas.js";

// Only response schemas are imported here — `SwapDKClient` validates responses
// at the HTTP boundary. Outgoing request bodies are NOT validated at runtime;
// call-sites are SwapDK code covered by TypeScript and validating them would
// be gratuitous work. Request schemas live in http-schemas.ts and are
// available to external consumers via the package's index re-exports.

export interface SwapDKClientConfig {
  /** Request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Max retries on network errors or 5xx responses (default: 2). */
  retries?: number;
}

export class SwapDKClient {
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    config: SwapDKClientConfig = {},
  ) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.retries = config.retries ?? 2;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.post("/quote", req, QuoteResponseSchema);
  }

  async swap(req: SwapRequest): Promise<SwapResponse> {
    return this.post("/swap", req, SwapResponseSchema);
  }

  async track(req: TrackRequest): Promise<TrackResponse> {
    return this.post("/track", req, TrackResponseSchema);
  }

  /**
   * Like `track`, but returns `null` instead of throwing when /track
   * responds with `track_not_found` (the "hash not in Midgard / Chainflip
   * scanner yet" case that's normal for a few minutes after broadcast).
   *
   * Every per-chain bridge needs the same 404-then-null shape inside its
   * `trackBridge` implementation, so it lives here to avoid five copies.
   * Non-404 errors propagate verbatim.
   */
  async trackOrNotFound(req: TrackRequest): Promise<TrackResponse | null> {
    try {
      return await this.track(req);
    } catch (err) {
      if (err instanceof SwapDKApiError && err.isNotFound) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Open a Chainflip deposit channel for a swap intent.
   *
   * Returns the deposit address + composite channel identifier the
   * client should fund (no memo / OP_RETURN — the address itself
   * encodes the intent). Required for BTC source via Chainflip; not
   * used on the THORChain path, which gets its vault address back
   * from `/quote` directly.
   */
  async openBrokerChannel(
    req: BrokerChannelRequest,
  ): Promise<BrokerChannelResponse> {
    return this.post(
      "/chainflip/broker/channel",
      req,
      BrokerChannelResponseSchema,
    );
  }

  // -------------------------------------------------------------------

  private post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return this.request<T>("POST", path, body, schema);
  }

  /**
   * Paths that allocate or mutate server-side state in a way the
   * client cannot reconcile after a partial failure. We must NEVER
   * auto-retry these — a 5xx (or network drop) may mean the
   * operation already succeeded server-side and the response was
   * lost. Retrying would allocate a second channel / submit a
   * second swap that the caller never sees.
   *
   * Idempotent endpoints (/quote, /track) stay retryable.
   */
  private static readonly NON_IDEMPOTENT_PATHS: ReadonlySet<string> = new Set([
    "/chainflip/broker/channel",
  ]);

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    attempt = 0,
  ): Promise<T> {
    const url = `${this.apiUrl.replace(/\/+$/, "")}${path}`;
    const retryable = !SwapDKClient.NON_IDEMPOTENT_PATHS.has(path);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network-level failure (timeout, DNS, connection refused).
      if (retryable && attempt < this.retries) {
        await sleep(200 * 2 ** attempt);
        return this.request(method, path, body, schema, attempt + 1);
      }
      throw new SwapDKNetworkError(path, err);
    }

    if (!res.ok) {
      // Read text first — a Response body can only be consumed once.
      const text = await res.text().catch(() => "");
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* plain text body */ }

      // swap-engine uses "errorCode" on /quote and /swap, "error" on /track.
      // Accept either as the error-code field.
      const errorCode =
        typeof json["errorCode"] === "string"
          ? json["errorCode"]
          : typeof json["error"] === "string"
            ? json["error"]
            : undefined;
      const message = typeof json["message"] === "string" ? json["message"] : (text || undefined);
      const apiError = new SwapDKApiError(res.status, path, errorCode, message);

      // Retry on 5xx (server errors) only — and only for idempotent paths.
      if (retryable && res.status >= 500 && attempt < this.retries) {
        await sleep(200 * 2 ** attempt);
        return this.request(method, path, body, schema, attempt + 1);
      }
      throw apiError;
    }

    // Response body decode + zod parse.
    const json: unknown = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first ? first.path.map(String).join(".") || "(root)" : "(root)";
      const why = first ? first.message : "shape did not match schema";
      throw new SwapDKApiError(
        res.status,
        path,
        "response_schema_mismatch",
        `${where}: ${why}`,
        parsed.error,
      );
    }
    return parsed.data;
  }
}
