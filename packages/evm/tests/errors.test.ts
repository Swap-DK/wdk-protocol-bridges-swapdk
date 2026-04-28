import { describe, it, expect } from "vitest";
import {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

describe("SwapDKError", () => {
  it("sets name to class name", () => {
    expect(new SwapDKError("msg").name).toBe("SwapDKError");
    expect(new SwapDKNetworkError("/quote").name).toBe("SwapDKNetworkError");
    expect(new SwapDKApiError(400, "/quote").name).toBe("SwapDKApiError");
    expect(new SwapDKProviderError("A", "B", []).name).toBe("SwapDKProviderError");
    expect(new SwapDKUserError("msg").name).toBe("SwapDKUserError");
  });

  it("all subclasses are instanceof SwapDKError", () => {
    expect(new SwapDKNetworkError("/q")).toBeInstanceOf(SwapDKError);
    expect(new SwapDKApiError(500, "/q")).toBeInstanceOf(SwapDKError);
    expect(new SwapDKProviderError("A", "B", [])).toBeInstanceOf(SwapDKError);
    expect(new SwapDKUserError("msg")).toBeInstanceOf(SwapDKError);
  });
});

describe("SwapDKNetworkError", () => {
  it("includes path in message", () => {
    expect(new SwapDKNetworkError("/quote").message).toContain("/quote");
  });

  it("includes cause message when cause is an Error", () => {
    const err = new SwapDKNetworkError("/swap", new Error("ECONNREFUSED"));
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("does not throw when cause is not an Error", () => {
    expect(() => new SwapDKNetworkError("/swap", "string cause")).not.toThrow();
  });
});

describe("SwapDKApiError", () => {
  it("includes status, path and errorCode in message", () => {
    const err = new SwapDKApiError(404, "/swap", "ROUTE_NOT_FOUND", "expired");
    expect(err.message).toContain("404");
    expect(err.message).toContain("/swap");
    expect(err.message).toContain("ROUTE_NOT_FOUND");
    expect(err.message).toContain("expired");
  });

  it("isStaleRoute is true for 404", () => {
    expect(new SwapDKApiError(404, "/swap").isStaleRoute).toBe(true);
  });

  it("isStaleRoute is true for 410", () => {
    expect(new SwapDKApiError(410, "/swap").isStaleRoute).toBe(true);
  });

  it("isStaleRoute is true for STALE_ROUTE errorCode", () => {
    expect(new SwapDKApiError(400, "/swap", "STALE_ROUTE").isStaleRoute).toBe(true);
  });

  it("isStaleRoute is true for ROUTE_NOT_FOUND errorCode", () => {
    expect(new SwapDKApiError(400, "/swap", "ROUTE_NOT_FOUND").isStaleRoute).toBe(true);
  });

  it("isStaleRoute is false for other errors", () => {
    expect(new SwapDKApiError(400, "/swap", "BAD_PARAM").isStaleRoute).toBe(false);
    expect(new SwapDKApiError(500, "/swap").isStaleRoute).toBe(false);
  });

  describe("isProviderUnsupported", () => {
    it("true only for /swap 422 swapProviderUnsupported", () => {
      expect(
        new SwapDKApiError(422, "/swap", "swapProviderUnsupported").isProviderUnsupported,
      ).toBe(true);
    });

    it("false for /swap with other status codes", () => {
      expect(
        new SwapDKApiError(400, "/swap", "swapProviderUnsupported").isProviderUnsupported,
      ).toBe(false);
      expect(
        new SwapDKApiError(502, "/swap", "swapProviderUnsupported").isProviderUnsupported,
      ).toBe(false);
    });

    it("false for 422 with other errorCode", () => {
      expect(new SwapDKApiError(422, "/swap").isProviderUnsupported).toBe(false);
      expect(
        new SwapDKApiError(422, "/swap", "other_error").isProviderUnsupported,
      ).toBe(false);
    });

    it("false for 422 on other paths (e.g. /quote, /track)", () => {
      expect(
        new SwapDKApiError(422, "/quote", "swapProviderUnsupported").isProviderUnsupported,
      ).toBe(false);
      expect(
        new SwapDKApiError(422, "/track", "swapProviderUnsupported").isProviderUnsupported,
      ).toBe(false);
    });

    it("does not collide with isStaleRoute or isNotFound", () => {
      const e = new SwapDKApiError(422, "/swap", "swapProviderUnsupported");
      expect(e.isProviderUnsupported).toBe(true);
      expect(e.isStaleRoute).toBe(false);
      expect(e.isNotFound).toBe(false);
    });
  });
});

describe("SwapDKProviderError", () => {
  it("includes assets and provider errors in message", () => {
    const err = new SwapDKProviderError("ETH.ETH", "BTC.BTC", [
      { provider: "THORCHAIN", message: "no pool" },
    ]);
    expect(err.message).toContain("ETH.ETH");
    expect(err.message).toContain("BTC.BTC");
    expect(err.message).toContain("THORCHAIN");
    expect(err.message).toContain("no pool");
  });

  it("works with empty providerErrors", () => {
    const err = new SwapDKProviderError("ETH.ETH", "BTC.BTC", []);
    expect(err.message).toContain("No routes found");
  });
});
