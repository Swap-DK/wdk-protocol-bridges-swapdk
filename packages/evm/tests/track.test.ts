import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKClient } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { SwapDKApiError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { SwapDKBridgeEvm } from "../src/SwapDKBridgeEvm.js";
import { SwapDKUserError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { EvmWalletAccount, TrackResponse } from "../src/types.js";

const API_URL = "https://api.swapdk.test";
const API_KEY = "test-key";

const account: EvmWalletAccount = {
  getAddress: () => "0xSender",
  sendTransaction: () => Promise.resolve("0xhash"),
};

function makeTrackResponse(overrides: Partial<TrackResponse> = {}): TrackResponse {
  return {
    chainId: "ETH",
    hash: "0xabc",
    block: 100,
    type: "swap",
    status: "pending",
    trackingStatus: "pending",
    fromAsset: "ETH~ETH",
    fromAmount: "0.01",
    fromAddress: "0xFrom",
    toAsset: "BTC~BTC",
    toAmount: "0.0003",
    toAddress: "bc1qxyz",
    finalisedAt: -1,
    meta: { provider: "THORCHAIN", providerAction: "swap" },
    payload: { memo: "=:BTC.BTC:bc1qxyz:0/1/0" },
    legs: [],
    ...overrides,
  };
}

// ---------- SwapDKClient.track --------------------------------------------

describe("SwapDKClient.track", () => {
  let client: SwapDKClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new SwapDKClient(API_URL, API_KEY, { retries: 0 });
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  function stub(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  it("POSTs to /track with hash and chainId and returns parsed response", async () => {
    const body = makeTrackResponse({ status: "completed" });
    stub(body);

    const result = await client.track({ hash: "0xabc", chainId: "1" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/track`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ hash: "0xabc", chainId: "1" });
    expect(result).toEqual(body);
  });

  it("maps 404 track_not_found to SwapDKApiError with isNotFound=true", async () => {
    stub(
      {
        error: "track_not_found",
        message: "track: transaction not found in THORChain/MAYAChain midgard: 0xabc",
      },
      404,
    );

    const err = await client
      .track({ hash: "0xabc", chainId: "1" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(SwapDKApiError);
    expect(err.status).toBe(404);
    expect(err.errorCode).toBe("track_not_found");
    expect(err.isNotFound).toBe(true);
    expect(err.isStaleRoute).toBe(false); // path is /track, not /swap
  });

  it("maps 502 track_failed to SwapDKApiError (not isNotFound)", async () => {
    const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 0 });
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: "track_failed", message: "midgard: timeout" }),
      text: () => Promise.resolve('{"error":"track_failed","message":"midgard: timeout"}'),
    });

    const err = await retryClient
      .track({ hash: "0xabc", chainId: "1" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(SwapDKApiError);
    expect(err.status).toBe(502);
    expect(err.errorCode).toBe("track_failed");
    expect(err.isNotFound).toBe(false);
  });
});

// ---------- SwapDKApiError.isNotFound -------------------------------------

describe("SwapDKApiError.isNotFound", () => {
  it("true only for /track 404 track_not_found", () => {
    expect(new SwapDKApiError(404, "/track", "track_not_found").isNotFound).toBe(true);
  });

  it("false for 404 on other paths", () => {
    expect(new SwapDKApiError(404, "/swap", "track_not_found").isNotFound).toBe(false);
  });

  it("false for /track but wrong errorCode", () => {
    expect(new SwapDKApiError(404, "/track").isNotFound).toBe(false);
    expect(new SwapDKApiError(404, "/track", "other_error").isNotFound).toBe(false);
  });

  it("false for /track 502 track_failed", () => {
    expect(new SwapDKApiError(502, "/track", "track_failed").isNotFound).toBe(false);
  });
});

// ---------- SwapDKBridgeEvm.trackBridge + waitForBridge -------------------

describe("SwapDKBridgeEvm tracking", () => {
  let bridge: SwapDKBridgeEvm;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridge = new SwapDKBridgeEvm(account, {
      apiUrl: API_URL,
      apiKey: API_KEY,
      retries: 0,
    });
    bridge.setSourceChain("ethereum");
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stub(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  describe("trackBridge", () => {
    it("returns the tracking response on 200", async () => {
      stub(makeTrackResponse({ status: "pending" }));
      const result = await bridge.trackBridge("0xabc");
      expect(result?.status).toBe("pending");
    });

    it("defaults chainId to the SwapKit prefix of the source chain", async () => {
      stub(makeTrackResponse());
      await bridge.trackBridge("0xabc");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.chainId).toBe("ETH");
    });

    it("passes through an explicit chainId override", async () => {
      stub(makeTrackResponse());
      await bridge.trackBridge("0xabc", "1");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.chainId).toBe("1");
    });

    it("returns null on 404 track_not_found", async () => {
      stub({ error: "track_not_found", message: "not found" }, 404);
      const result = await bridge.trackBridge("0xabc");
      expect(result).toBeNull();
    });

    it("propagates non-404 HTTP errors", async () => {
      stub({ error: "track_failed", message: "midgard: timeout" }, 502);
      await expect(bridge.trackBridge("0xabc")).rejects.toBeInstanceOf(SwapDKApiError);
    });
  });

  describe("waitForBridge", () => {
    it("resolves when status reaches a terminal value", async () => {
      stub(makeTrackResponse({ status: "pending" }));
      stub(makeTrackResponse({ status: "swapping" }));
      stub(makeTrackResponse({ status: "completed" }));

      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xabc", undefined, {
        pollIntervalMs: 1_000,
        timeoutMs: 30_000,
      });

      // Three polls, each preceded (from poll 2 onwards) by a 1s wait.
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result.status).toBe("completed");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("calls onUpdate for each successful poll", async () => {
      stub(makeTrackResponse({ status: "pending" }));
      stub(makeTrackResponse({ status: "completed" }));

      const updates: string[] = [];
      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xabc", undefined, {
        pollIntervalMs: 500,
        timeoutMs: 10_000,
        onUpdate: (s) => updates.push(String(s.status)),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;
      expect(updates).toEqual(["pending", "completed"]);
    });

    it("skips onUpdate on not-found (null) polls but keeps trying", async () => {
      // First two polls: 404 → null. Third: completed.
      stub({ error: "track_not_found", message: "nope" }, 404);
      stub({ error: "track_not_found", message: "nope" }, 404);
      stub(makeTrackResponse({ status: "completed" }));

      const updates: TrackResponse[] = [];
      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xabc", undefined, {
        pollIntervalMs: 500,
        timeoutMs: 10_000,
        onUpdate: (s) => updates.push(s),
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result.status).toBe("completed");
      expect(updates.length).toBe(1);
    });

    it("throws SwapDKUserError when timeout elapses without terminal status", async () => {
      // Always pending.
      for (let i = 0; i < 20; i++) stub(makeTrackResponse({ status: "pending" }));

      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xabc", undefined, {
        pollIntervalMs: 1_000,
        timeoutMs: 2_500,
      });
      const caught = promise.catch((e) => e);
      await vi.advanceTimersByTimeAsync(3_000);
      const err = await caught;
      expect(err).toBeInstanceOf(SwapDKUserError);
      expect(String(err.message)).toContain("pending");
    });

    it("propagates non-404 HTTP errors from a poll", async () => {
      stub({ error: "track_failed", message: "midgard: timeout" }, 502);
      await expect(
        bridge.waitForBridge("0xabc", undefined, {
          pollIntervalMs: 500,
          timeoutMs: 5_000,
        }),
      ).rejects.toBeInstanceOf(SwapDKApiError);
    });
  });
});
