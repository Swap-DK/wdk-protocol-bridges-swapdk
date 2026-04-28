// ---------------------------------------------------------------------------
// HTTP client for the SwapDK swap-engine REST API.
// ---------------------------------------------------------------------------

import { SwapDKApiError, SwapDKNetworkError } from "./errors.js";
import type {
  QuoteRequest,
  QuoteResponse,
  SwapRequest,
  SwapResponse,
  TrackRequest,
  TrackResponse,
} from "./http-types.js";

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
    return this.post<QuoteResponse>("/quote", req);
  }

  async swap(req: SwapRequest): Promise<SwapResponse> {
    return this.post<SwapResponse>("/swap", req);
  }

  async track(req: TrackRequest): Promise<TrackResponse> {
    return this.post<TrackResponse>("/track", req);
  }

  // -------------------------------------------------------------------

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const url = `${this.apiUrl.replace(/\/+$/, "")}${path}`;

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
      if (attempt < this.retries) {
        await sleep(200 * 2 ** attempt);
        return this.request(method, path, body, attempt + 1);
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

      // Retry on 5xx (server errors) only.
      if (res.status >= 500 && attempt < this.retries) {
        await sleep(200 * 2 ** attempt);
        return this.request(method, path, body, attempt + 1);
      }
      throw apiError;
    }

    return (await res.json()) as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
