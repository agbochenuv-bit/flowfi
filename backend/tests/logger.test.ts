import { describe, expect, it } from "vitest";
import { redactLogValue } from "../src/logger.js";

describe("log data redaction", () => {
  it("redacts wallet addresses, credentials, and URLs from nested log values", () => {
    const walletAddress = `G${"A".repeat(55)}`;

    expect(
      redactLogValue({
        message: `User ${walletAddress} called https://hooks.example.test/path?token=secret`,
        authorization: "Bearer private-token",
      }),
    ).toEqual({
      message: "User [REDACTED] called [REDACTED]",
      authorization: "[REDACTED]",
    });
  });
});