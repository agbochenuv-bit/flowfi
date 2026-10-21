import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthExpiredError, authenticatedFetch, getJwtExpiry } from "./auth";

describe("auth helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the expiration from a base64url JWT payload", () => {
    const payload = btoa(JSON.stringify({ exp: 2000000000 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(getJwtExpiry(`header.${payload}.signature`)).toBe(2_000_000_000_000);
  });

  it("adds the wallet JWT as a Bearer header", async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 200 } as Response);

    await authenticatedFetch("/api", {}, "wallet-token");

    const requestOptions = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(new Headers(requestOptions?.headers).get("Authorization")).toBe("Bearer wallet-token");
  });

  it("signals the wallet provider and rejects on expired credentials", async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 401 } as Response);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await expect(authenticatedFetch("/private")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "flowfi:auth-expired" }));
  });
});