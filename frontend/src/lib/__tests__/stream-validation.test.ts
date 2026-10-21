/**
 * stream-validation.test.ts
 *
 * Shared test suite for stream-creation validation logic.
 * This verifies the acceptance criteria from the audit issue:
 *   "All three entry points enforce identical validation rules,
 *    verified by a shared test suite run against each."
 *
 * The tests exercise the canonical `validateStreamForm` function that
 * is now the single source of truth for all three entry points:
 *   1. StreamCreationWizard (modal)
 *   2. CreateStreamContent (full-page)
 *   3. DashboardView inline settings form
 */

import { describe, it, expect } from "vitest";
import {
  validateStreamForm,
  validateRecipient,
  validateToken,
  validateTokenForNetwork,
  validateAmount,
  validateDuration,
  validateRate,
  getSpendableBalance,
  XLM_BASE_RESERVE,
  type StreamFormData,
} from "@/lib/stream-validation";

// ─── Test data ────────────────────────────────────────────────────────────────

// Valid 56-char Stellar public key (Ed25519 StrKey with a correct checksum)
const VALID_KEY = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";
// Same key with a tampered final character -> checksum mismatch
const INVALID_KEY_CHECKSUM = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR8";
// Muxed account address (MED25519) which the stream contract does not support
const MUXED_KEY =
  "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const INVALID_KEY_MESSAGE =
  "Invalid Stellar public key (must start with 'G' and be 56 characters)";
const INVALID_KEY_SHORT = "GABCDEFGH";
const INVALID_KEY_LOWERCASE = "gg32xlqszxfby6w3fndrbaunn4uxga3p3m6dlku5bu3rq2ufbvserb5k";
const INVALID_KEY_WRONG_PREFIX = "SG32XLQSZXFBY6W3FNDRBAUNN4UXGA3P3M6DLKU5BU3RQ2UFBVSERB5K";

const VALID_FORM: StreamFormData = {
  recipient: VALID_KEY,
  token: "USDC",
  amount: "100",
  duration: "30",
  durationUnit: "days",
};

// ─── validateRecipient ────────────────────────────────────────────────────────

describe("validateRecipient", () => {
  it("accepts a valid Stellar public key", () => {
    expect(validateRecipient(VALID_KEY)).toBeNull();
  });

  it("accepts a key with leading/trailing whitespace", () => {
    expect(validateRecipient(`  ${VALID_KEY}  `)).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateRecipient("")).toBe("Recipient address is required");
  });

  it("rejects whitespace-only string", () => {
    expect(validateRecipient("   ")).toBe("Recipient address is required");
  });

  it("rejects a short key", () => {
    expect(validateRecipient(INVALID_KEY_SHORT)).toBe(
      INVALID_KEY_MESSAGE,
    );
  });

  it("rejects a lowercase key", () => {
    expect(validateRecipient(INVALID_KEY_LOWERCASE)).toBe(
      INVALID_KEY_MESSAGE,
    );
  });

  it("rejects a key with wrong prefix (secret key)", () => {
    expect(validateRecipient(INVALID_KEY_WRONG_PREFIX)).toBe(
      INVALID_KEY_MESSAGE,
    );
  });

  it("rejects an arbitrary string", () => {
    expect(validateRecipient("not-a-key")).toBe(
      INVALID_KEY_MESSAGE,
    );
  });

  it("rejects a key with an invalid checksum", () => {
    expect(validateRecipient(INVALID_KEY_CHECKSUM)).toBe(INVALID_KEY_MESSAGE);
  });

  it("rejects a muxed account address (M...)", () => {
    expect(validateRecipient(MUXED_KEY)).toBe(INVALID_KEY_MESSAGE);
  });

  it("accepts a valid key padded with mixed whitespace", () => {
    expect(validateRecipient(`\n\t ${VALID_KEY} \t`)).toBeNull();
  });
});

// ─── validateToken ────────────────────────────────────────────────────────────

describe("validateToken", () => {
  it("accepts USDC", () => {
    expect(validateToken("USDC")).toBeNull();
  });

  it("accepts XLM", () => {
    expect(validateToken("XLM")).toBeNull();
  });

  it("accepts EURC", () => {
    expect(validateToken("EURC")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateToken("")).toBe("Please select a token");
  });

  it("rejects whitespace-only string", () => {
    expect(validateToken("   ")).toBe("Please select a token");
  });

  it("rejects an unsupported token symbol", () => {
    expect(validateToken("BTC")).toBe(
      "Unsupported token. Please select XLM, USDC, or EURC.",
    );
  });

  it("rejects an arbitrary string", () => {
    expect(validateToken("random-token")).toBe(
      "Unsupported token. Please select XLM, USDC, or EURC.",
    );
  });

  it("is case-insensitive (accepts lowercase usdc)", () => {
    expect(validateToken("usdc")).toBeNull();
  });
});

// ─── validateTokenForNetwork ──────────────────────────────────────────────────

describe("validateTokenForNetwork", () => {
  it("accepts USDC", () => {
    expect(validateTokenForNetwork("USDC")).toBeNull();
  });

  it("accepts XLM", () => {
    expect(validateTokenForNetwork("XLM")).toBeNull();
  });

  it("accepts EURC", () => {
    expect(validateTokenForNetwork("EURC")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateTokenForNetwork("")).toBe("Please select a token");
  });

  it("rejects an unsupported token symbol", () => {
    expect(validateTokenForNetwork("DOGE")).toBe(
      "Unsupported token. Please select XLM, USDC, or EURC.",
    );
  });

  it("is case-insensitive (accepts lowercase xlm)", () => {
    expect(validateTokenForNetwork("xlm")).toBeNull();
  });

  it("rejects a supported token when the wallet is on a different network", () => {
    expect(validateTokenForNetwork("USDC", "Other")).toBe(
      "Wallet network does not match the network configured for this app.",
    );
  });
});

// ─── validateAmount ───────────────────────────────────────────────────────────

describe("validateAmount", () => {
  it("accepts a valid positive integer", () => {
    expect(validateAmount("100")).toBeNull();
  });

  it("accepts a valid decimal", () => {
    expect(validateAmount("0.5")).toBeNull();
  });

  it("accepts maximum precision (7 decimal places)", () => {
    expect(validateAmount("1.1234567")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateAmount("")).toBe("Amount is required");
  });

  it("rejects zero", () => {
    expect(validateAmount("0")).toBe("Amount must be a positive number");
  });

  it("rejects negative amount", () => {
    expect(validateAmount("-5")).not.toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(validateAmount("abc")).not.toBeNull();
  });

  it("rejects too many decimal places (>7)", () => {
    expect(validateAmount("1.12345678")).toBe(
      "Amount exceeds maximum precision (7 decimal places)",
    );
  });

  it("uses the selected token's configured precision", () => {
    expect(validateAmount("1.1234567", undefined, "USDC", 6)).toBe(
      "Amount exceeds maximum precision (6 decimal places)",
    );
  });

  // ── Wallet balance checks ───────────────────────────────────────────────

  it("passes when amount is within wallet balance", () => {
    expect(validateAmount("50", "100")).toBeNull();
  });

  it("passes when amount equals wallet balance exactly", () => {
    expect(validateAmount("100", "100")).toBeNull();
  });

  it("rejects when amount exceeds wallet balance", () => {
    expect(validateAmount("200", "100")).toBe(
      "Amount exceeds wallet balance",
    );
  });

  it("skips balance check when walletBalance is null", () => {
    expect(validateAmount("999999", null)).toBeNull();
  });

  it("skips balance check when walletBalance is undefined", () => {
    expect(validateAmount("999999", undefined)).toBeNull();
  });
});

// ─── XLM base reserve / spendable balance ─────────────────────────────────────

describe("getSpendableBalance", () => {
  it("subtracts the base reserve from XLM balances", () => {
    expect(getSpendableBalance("100", "XLM")).toBe(100 - XLM_BASE_RESERVE);
  });

  it("does not subtract a reserve from non-XLM tokens", () => {
    expect(getSpendableBalance("100", "USDC")).toBe(100);
    expect(getSpendableBalance("100")).toBe(100);
  });

  it("never returns a negative spendable balance", () => {
    expect(getSpendableBalance("0.5", "XLM")).toBe(0);
  });

  it("returns null when no usable balance is known", () => {
    expect(getSpendableBalance(null, "XLM")).toBeNull();
    expect(getSpendableBalance(undefined, "USDC")).toBeNull();
    expect(getSpendableBalance("", "XLM")).toBeNull();
    expect(getSpendableBalance("not-a-number", "XLM")).toBeNull();
  });
});

describe("validateAmount with XLM reserve", () => {
  it("rejects an XLM amount that would dip into the base reserve", () => {
    // 100 XLM balance, 1 XLM kept in reserve -> 99 spendable
    expect(validateAmount("99", "100", "XLM")).toBeNull();
    expect(validateAmount("99.5", "100", "XLM")).toBe(
      "Amount exceeds wallet balance",
    );
  });

  it("still allows the full balance for non-XLM tokens", () => {
    expect(validateAmount("100", "100", "USDC")).toBeNull();
  });

  it("applies the reserve check through validateStreamForm step 4", () => {
    const errors = validateStreamForm(
      { ...VALID_FORM, token: "XLM", amount: "99.5" },
      { step: 4, walletBalance: "100" },
    );
    expect(errors.amount).toBe("Amount exceeds wallet balance");
  });
});

// ─── validateDuration ─────────────────────────────────────────────────────────

describe("validateDuration", () => {
  it("accepts a positive integer", () => {
    expect(validateDuration("30")).toBeNull();
  });

  it("accepts a decimal", () => {
    expect(validateDuration("0.5")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateDuration("")).toBe("Duration is required");
  });

  it("rejects zero", () => {
    expect(validateDuration("0")).toBe(
      "Duration must be a positive number",
    );
  });

  it("rejects negative number", () => {
    expect(validateDuration("-10")).toBe(
      "Duration must be a positive number",
    );
  });

  it("rejects non-numeric string", () => {
    expect(validateDuration("abc")).toBe(
      "Duration must be a positive number",
    );
  });
});

// ─── validateRate ──────────────────────────────────────────────────────────────

const RATE_TOO_SMALL =
  "Stream rate is too small — the amount divided by duration rounds to zero. Increase the amount or shorten the duration.";

describe("validateRate", () => {
  it("accepts a valid amount and duration (rate > 0)", () => {
    // 100 * 1e7 = 1,000,000,000 stroops / 30 days (2,592,000 sec) = 385 rate
    expect(validateRate("100", "30", "days")).toBeNull();
  });

  it("accepts the boundary case where rate is exactly 1", () => {
    // 2592000 stroops / 2592000 sec (1 month) = 1 stroop/sec
    // 2592000 stroops = 0.2592 tokens
    expect(validateRate("0.2592", "1", "months")).toBeNull();
  });

  it("rejects when the rate rounds to zero (1 stroop over 1 month)", () => {
    // 0.0000001 tokens = 1 stroop; 1 month = 2,592,000 sec → rate = 0
    expect(validateRate("0.0000001", "1", "months")).toBe(RATE_TOO_SMALL);
  });

  it("rejects when the rate rounds to zero over a long duration in seconds", () => {
    // 1 stroop / 10 seconds = 0
    expect(validateRate("0.0000001", "10", "seconds")).toBe(RATE_TOO_SMALL);
  });

  it("rejects a positive duration that rounds to zero contract seconds", () => {
    expect(validateRate("1", "0.4", "seconds")).toBe(
      "Duration must round to at least one second",
    );
  });

  it("returns null when amount is empty (handled elsewhere)", () => {
    expect(validateRate("", "30", "days")).toBeNull();
  });

  it("returns null when duration is empty (handled elsewhere)", () => {
    expect(validateRate("100", "", "days")).toBeNull();
  });

  it("returns null when amount is zero or negative (handled elsewhere)", () => {
    expect(validateRate("0", "30", "days")).toBeNull();
    expect(validateRate("-5", "30", "days")).toBeNull();
  });

  it("returns null when inputs are non-numeric (handled elsewhere)", () => {
    expect(validateRate("abc", "30", "days")).toBeNull();
    expect(validateRate("100", "xyz", "days")).toBeNull();
  });

  it("works across different duration units", () => {
    // 100 tokens over 1 hour = 1e9 stroops / 3600 sec ≈ 277777
    expect(validateRate("100", "1", "hours")).toBeNull();
    // 100 tokens over 1 week = 1e9 / 604800 ≈ 1653
    expect(validateRate("100", "1", "weeks")).toBeNull();
    // 100 tokens over 1 minute = 1e9 / 60 ≈ 16666666
    expect(validateRate("100", "1", "minutes")).toBeNull();
  });

  // ── Overflow checks ──────────────────────────────────────────────────────

  it("rejects an amount that exceeds i128 max", () => {
    // i128 max in stroops = 170141183460469231731687303715884105727 (≈1.7e38).
    // 1e32 tokens * 1e7 stroops/token = 1e39 stroops, which exceeds i128 max.
    expect(validateRate("1e32", "1", "days")).toBe(
      "Amount exceeds the maximum supported value",
    );
  });

  it("rejects a duration that exceeds u64 max", () => {
    // u64 max in seconds = 18446744073709551615.
    // In months (2,592,000 sec each): u64_max / 2592000 ≈ 7.12e12 months.
    // Use 1e13 months to exceed u64 max.
    expect(validateRate("100", "10000000000000", "months")).toBe(
      "Duration exceeds the maximum supported value",
    );
  });
});

// ─── validateStreamForm (composite) ───────────────────────────────────────────

describe("validateStreamForm", () => {
  describe("full-form mode (no step)", () => {
    it("returns no errors for a fully valid form", () => {
      expect(validateStreamForm(VALID_FORM)).toEqual({});
    });

    it("returns errors for every invalid field at once", () => {
      const badForm: StreamFormData = {
        recipient: "",
        token: "",
        amount: "",
        duration: "",
        durationUnit: "days",
      };
      const errors = validateStreamForm(badForm);
      expect(errors.recipient).toBeDefined();
      expect(errors.token).toBeDefined();
      expect(errors.amount).toBeDefined();
      expect(errors.duration).toBeDefined();
    });

    it("validates recipient format", () => {
      const errors = validateStreamForm({
        ...VALID_FORM,
        recipient: "not-valid",
      });
      expect(errors.recipient).toBe(INVALID_KEY_MESSAGE);
    });

    it("checks wallet balance when provided", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "1000" },
        { walletBalance: "500" },
      );
      expect(errors.amount).toBe("Amount exceeds wallet balance");
    });

    it("validates rate and surfaces rate-too-small in full-form mode", () => {
      const errors = validateStreamForm({
        ...VALID_FORM,
        amount: "0.0000001",
        duration: "1",
        durationUnit: "months",
      });
      expect(errors.rate).toBe(
        "Stream rate is too small — the amount divided by duration rounds to zero. Increase the amount or shorten the duration.",
      );
    });

    it("does not set a rate error for valid amount and duration in full-form mode", () => {
      const errors = validateStreamForm(VALID_FORM);
      expect(errors.rate).toBeUndefined();
    });

    it("rejects an unsupported token in full-form mode", () => {
      const errors = validateStreamForm({
        ...VALID_FORM,
        token: "BTC",
      });
      expect(errors.token).toBe(
        "Unsupported token. Please select XLM, USDC, or EURC.",
      );
    });
  });

  describe("step mode (wizard)", () => {
    it("step 1 (template): no field validation", () => {
      const badForm: StreamFormData = {
        recipient: "",
        token: "",
        amount: "",
        duration: "",
        durationUnit: "days",
      };
      expect(validateStreamForm(badForm, { step: 1 })).toEqual({});
    });

    it("step 2 (recipient): only validates recipient", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, recipient: "" },
        { step: 2 },
      );
      expect(errors.recipient).toBeDefined();
      expect(errors.amount).toBeUndefined();
      expect(errors.token).toBeUndefined();
      expect(errors.duration).toBeUndefined();
    });

    it("step 3 (token): only validates token", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, token: "" },
        { step: 3 },
      );
      expect(errors.token).toBeDefined();
      expect(errors.recipient).toBeUndefined();
    });

    it("step 4 (amount): validates amount and balance", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "1000" },
        { step: 4, walletBalance: "500" },
      );
      expect(errors.amount).toBe("Amount exceeds wallet balance");
      expect(errors.recipient).toBeUndefined();
    });

    it("step 5 (duration): only validates duration", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, duration: "" },
        { step: 5 },
      );
      expect(errors.duration).toBeDefined();
      expect(errors.amount).toBeUndefined();
    });

    it("step 5 (duration): validates rate when amount and duration are set", () => {
      // 1 stroop over 1 month → rate rounds to zero
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "0.0000001", duration: "1", durationUnit: "months" },
        { step: 5 },
      );
      expect(errors.rate).toBe(
        "Stream rate is too small — the amount divided by duration rounds to zero. Increase the amount or shorten the duration.",
      );
    });

    it("step 5 (duration): passes rate when amount and duration are valid", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "100", duration: "30", durationUnit: "days" },
        { step: 5 },
      );
      expect(errors.rate).toBeUndefined();
    });

    it("step 4 (amount): surfaces rate error when duration is already filled", () => {
      // Amount step with a valid duration already entered → rate rounds to zero
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "0.0000001", duration: "1", durationUnit: "months" },
        { step: 4 },
      );
      expect(errors.rate).toBe(
        "Stream rate is too small — the amount divided by duration rounds to zero. Increase the amount or shorten the duration.",
      );
    });

    it("step 4 (amount): skips rate check when duration is empty", () => {
      // Duration not yet entered → step 5 will catch rate issues
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "0.0000001", duration: "" },
        { step: 4 },
      );
      expect(errors.rate).toBeUndefined();
    });

    it("step 3 (token): rejects an unsupported token", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, token: "BTC" },
        { step: 3 },
      );
      expect(errors.token).toBe(
        "Unsupported token. Please select XLM, USDC, or EURC.",
      );
    });
  });

  // ─── Acceptance criteria: identical rules across entry points ───────────

  describe("acceptance criteria: consistent validation across entry points", () => {
    /**
     * Scenario: All three entry points must reject an invalid recipient.
     * Before this fix, create-stream-content.tsx did NOT check recipient
     * format on form submission.
     */
    it("rejects invalid recipient format (Functional Edge Case #3)", () => {
      const data: StreamFormData = {
        ...VALID_FORM,
        recipient: "invalid-address",
      };
      // Full-form mode (page + dashboard)
      expect(validateStreamForm(data).recipient).toBe(
        INVALID_KEY_MESSAGE,
      );
      // Step mode (wizard step 2)
      expect(validateStreamForm(data, { step: 2 }).recipient).toBe(
        INVALID_KEY_MESSAGE,
      );
    });

    /**
     * Scenario: All three entry points must reject amounts exceeding
     * wallet balance. Before this fix, only the wizard checked balance.
     */
    it("rejects amount exceeding wallet balance (consistency gap)", () => {
      const data: StreamFormData = { ...VALID_FORM, amount: "5000" };
      const opts = { walletBalance: "1000" };
      // Full-form mode
      expect(validateStreamForm(data, opts).amount).toBe(
        "Amount exceeds wallet balance",
      );
      // Step mode
      expect(validateStreamForm(data, { step: 4, ...opts }).amount).toBe(
        "Amount exceeds wallet balance",
      );
    });

    /**
     * Scenario: All three entry points must reject amounts with too many
     * decimal places.
     */
    it("rejects excessive precision uniformly", () => {
      const data: StreamFormData = {
        ...VALID_FORM,
        amount: "1.12345678",
      };
      expect(validateStreamForm(data).amount).toBe(
        "Amount exceeds maximum precision (7 decimal places)",
      );
    });
  });
});
