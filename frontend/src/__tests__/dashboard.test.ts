import { describe, it, expect, beforeEach, vi } from "vitest";
import { mapBackendStreamToFrontend } from "../lib/dashboard";
import { TOKEN_ADDRESSES } from "../lib/soroban";
import type { BackendStream, BackendStreamEvent } from "../lib/api-types";
import {
  ANNOTATION_STORAGE_PREFIX,
  annotationStorageKey,
  deleteAnnotation,
  exportAnnotations,
  loadAnnotation,
  loadAnnotations,
  saveAnnotation,
} from "../lib/annotations";

function makeStream(overrides: Partial<BackendStream> = {}): BackendStream {
  return {
    id: "db-1",
    streamId: 1,
    sender: "GSENDER000000000000000000000000000000000000000000000000",
    recipient: "GRECIPIENT0000000000000000000000000000000000000000000",
    tokenAddress: TOKEN_ADDRESSES.USDC,
    ratePerSecond: "1000000",
    depositedAmount: "100000000",
    withdrawnAmount: "20000000",
    startTime: 1_700_000_000,
    lastUpdateTime: 1_700_000_500,
    isActive: true,
    isPaused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const cancelledEvent: BackendStreamEvent = {
  id: "evt-1",
  streamId: 1,
  eventType: "CANCELLED",
  amount: null,
  transactionHash: "hash",
  ledgerSequence: 1,
  timestamp: 1_700_000_600,
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("mapBackendStreamToFrontend", () => {
  describe("token label", () => {
    it("resolves known token addresses to their symbol", () => {
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.XLM }), "G").token).toBe("XLM");
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.USDC }), "G").token).toBe("USDC");
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.EURC }), "G").token).toBe("EURC");
    });

    it("falls back to a shortened address for unknown tokens", () => {
      const addr = "CUNKNOWNTOKENADDRESS000000000000000000000000000000000000";
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: addr }), "G").token).toBe(
        `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      );
    });

    it("never returns the placeholder 'TOKEN'", () => {
      expect(mapBackendStreamToFrontend(makeStream(), "G").token).not.toBe("TOKEN");
    });
  });

  describe("status", () => {
    it("is Paused when the stream is paused", () => {
      expect(mapBackendStreamToFrontend(makeStream({ isPaused: true }), "G").status).toBe("Paused");
    });

    it("is Active when active and not paused", () => {
      expect(mapBackendStreamToFrontend(makeStream({ isActive: true, isPaused: false }), "G").status).toBe("Active");
    });

    it("is Cancelled when inactive with a CANCELLED event", () => {
      const s = makeStream({ isActive: false, isPaused: false, events: [cancelledEvent] });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Cancelled");
    });

    it("is Completed when inactive without a CANCELLED event", () => {
      const s = makeStream({ isActive: false, isPaused: false, events: [] });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Completed");
    });

    it("is Completed when inactive and events are absent", () => {
      const s = makeStream({ isActive: false, isPaused: false });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Completed");
    });
  });

  describe("date", () => {
    it("formats startTime as a UTC calendar date, independent of the runner's local timezone", () => {
      // 2023-11-14T22:13:20.000Z: in a negative UTC-offset local timezone this
      // instant falls on the previous local calendar day, which is exactly
      // the ambiguity this format must avoid.
      const s = makeStream({ startTime: 1_700_000_000 });
      expect(mapBackendStreamToFrontend(s, "G").date).toBe("2023-11-14");
    });

    it("is stable across different timestamps within the same UTC day", () => {
      const morning = makeStream({ startTime: 1_700_000_000 }); // 22:13:20 UTC
      const lateSameUtcDay = makeStream({ startTime: 1_700_003_000 }); // 23:03:20 UTC
      expect(mapBackendStreamToFrontend(morning, "G").date).toBe(
        mapBackendStreamToFrontend(lateSameUtcDay, "G").date,
      );
    });
  });
});

const WALLET_A = "GWALLETA0000000000000000000000000000000000000000000000";
const WALLET_B = "GWALLETB0000000000000000000000000000000000000000000000";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("transaction annotations", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  describe("storage and privacy boundaries", () => {
    it("namespaces annotation keys by wallet and stream id", () => {
      expect(annotationStorageKey(WALLET_A, 7)).toBe(`${ANNOTATION_STORAGE_PREFIX}${WALLET_A}:7`);
      expect(annotationStorageKey(WALLET_A, 7)).not.toBe(annotationStorageKey(WALLET_B, 7));
    });

    it("persists annotations locally without touching the network", () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      saveAnnotation(storage, WALLET_A, 7, { note: "internal ops note", tags: ["reconcile"] });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(loadAnnotation(storage, WALLET_A, 7)?.note).toBe("internal ops note");
      fetchSpy.mockRestore();
    });

    it("returns null for a missing annotation", () => {
      expect(loadAnnotation(storage, WALLET_A, 7)).toBeNull();
    });

    it("treats corrupt stored JSON as missing instead of throwing", () => {
      storage.setItem(annotationStorageKey(WALLET_A, 7), "{not-json");
      expect(loadAnnotation(storage, WALLET_A, 7)).toBeNull();
      expect(loadAnnotations(storage, WALLET_A)).toEqual({});
    });

    it("ignores stored values with an unexpected shape", () => {
      storage.setItem(annotationStorageKey(WALLET_A, 7), JSON.stringify({ note: 42 }));
      expect(loadAnnotation(storage, WALLET_A, 7)).toBeNull();
    });
  });

  describe("wallet switching isolation", () => {
    it("does not leak annotations across wallets", () => {
      saveAnnotation(storage, WALLET_A, 7, { note: "wallet A note" });
      saveAnnotation(storage, WALLET_B, 7, { note: "wallet B note" });

      expect(loadAnnotation(storage, WALLET_A, 7)?.note).toBe("wallet A note");
      expect(loadAnnotation(storage, WALLET_B, 7)?.note).toBe("wallet B note");
      expect(loadAnnotations(storage, WALLET_A)).toEqual({ 7: expect.objectContaining({ note: "wallet A note" }) });
      expect(loadAnnotations(storage, WALLET_B)).toEqual({ 7: expect.objectContaining({ note: "wallet B note" }) });
    });

    it("returns an empty map for a wallet with no annotations", () => {
      saveAnnotation(storage, WALLET_A, 7, { note: "wallet A note" });
      expect(loadAnnotations(storage, WALLET_B)).toEqual({});
    });
  });

  describe("annotation deletion", () => {
    it("removes only the targeted annotation", () => {
      saveAnnotation(storage, WALLET_A, 7, { note: "keep" });
      saveAnnotation(storage, WALLET_A, 8, { note: "remove" });

      deleteAnnotation(storage, WALLET_A, 8);

      expect(loadAnnotation(storage, WALLET_A, 8)).toBeNull();
      expect(loadAnnotation(storage, WALLET_A, 7)?.note).toBe("keep");
    });

    it("is a no-op when deleting a missing annotation", () => {
      expect(() => deleteAnnotation(storage, WALLET_A, 99)).not.toThrow();
      expect(loadAnnotation(storage, WALLET_A, 99)).toBeNull();
    });

    it("does not delete another wallet's annotation for the same stream", () => {
      saveAnnotation(storage, WALLET_B, 7, { note: "wallet B note" });
      deleteAnnotation(storage, WALLET_A, 7);
      expect(loadAnnotation(storage, WALLET_B, 7)?.note).toBe("wallet B note");
    });
  });

  describe("export behavior", () => {
    it("exports only the requesting wallet's annotations", () => {
      saveAnnotation(storage, WALLET_A, 7, { note: "wallet A note", tags: ["ops"] });
      saveAnnotation(storage, WALLET_B, 7, { note: "wallet B note" });

      const exported = exportAnnotations(storage, WALLET_A);

      expect(exported.wallet).toBe(WALLET_A);
      expect(Object.keys(exported.annotations)).toEqual(["7"]);
      expect(exported.annotations[7].note).toBe("wallet A note");
      expect(JSON.stringify(exported)).not.toContain("wallet B note");
    });

    it("exports an empty set when nothing is stored", () => {
      expect(exportAnnotations(storage, WALLET_A)).toEqual({ wallet: WALLET_A, annotations: {} });
    });

    it("skips corrupt entries during export without failing", () => {
      saveAnnotation(storage, WALLET_A, 7, { note: "valid" });
      storage.setItem(annotationStorageKey(WALLET_A, 8), "not-json");

      const exported = exportAnnotations(storage, WALLET_A);

      expect(Object.keys(exported.annotations)).toEqual(["7"]);
    });
  });
});
