import { describe, it, expect } from "vitest";
import {
  filterActivityEvents,
  sortActivityEvents,
  parseActivityFilters,
  serializeActivityFilters,
  DEFAULT_ACTIVITY_FILTERS,
  type ActivityFilters,
} from "./activityFilters";
import type { BackendStreamEvent, StreamEventType } from "@/lib/api-types";

function makeEvent(
  overrides: Partial<BackendStreamEvent> = {},
): BackendStreamEvent {
  return {
    id: "evt",
    streamId: 1,
    eventType: "CREATED",
    amount: "1000000",
    transactionHash: "abc123",
    ledgerSequence: 1,
    timestamp: 1_700_000_000,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const events: BackendStreamEvent[] = [
  makeEvent({ id: "a", eventType: "CREATED", streamId: 10, amount: "500", timestamp: 100, transactionHash: "0xAAA" }),
  makeEvent({ id: "b", eventType: "WITHDRAWN", streamId: 11, amount: "900", timestamp: 200, transactionHash: "0xBBB" }),
  makeEvent({ id: "c", eventType: "PAUSED", streamId: 12, amount: null, timestamp: 300, transactionHash: "0xCCC" }),
];

describe("filterActivityEvents", () => {
  it("returns everything when no filters are given", () => {
    expect(filterActivityEvents(events)).toHaveLength(3);
  });

  it("filters by event type", () => {
    const types: StreamEventType[] = ["CREATED", "PAUSED"];
    const result = filterActivityEvents(events, { types });
    expect(result.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("filters by inclusive timestamp range", () => {
    const filters: ActivityFilters = { fromTimestamp: 150, toTimestamp: 300 };
    expect(filterActivityEvents(events, filters).map((e) => e.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("searches tx hash case-insensitively and by stream id", () => {
    expect(filterActivityEvents(events, { search: "0xbbb" }).map((e) => e.id)).toEqual(["b"]);
    expect(filterActivityEvents(events, { search: "12" }).map((e) => e.id)).toEqual(["c"]);
  });

  it("combines filters (AND semantics)", () => {
    const result = filterActivityEvents(events, {
      types: ["WITHDRAWN", "PAUSED"],
      fromTimestamp: 250,
    });
    expect(result.map((e) => e.id)).toEqual(["c"]);
  });
});

describe("sortActivityEvents", () => {
  it("sorts by amount descending, treating null as zero", () => {
    const result = sortActivityEvents(events, "amount", "desc");
    expect(result.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by timestamp ascending", () => {
    const result = sortActivityEvents(events, "timestamp", "asc");
    expect(result.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal keys", () => {
    const tied = [
      makeEvent({ id: "x", amount: "5" }),
      makeEvent({ id: "y", amount: "5" }),
      makeEvent({ id: "z", amount: "5" }),
    ];
    expect(sortActivityEvents(tied, "amount").map((e) => e.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [...events];
    sortActivityEvents(input, "streamId", "asc");
    expect(input.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("parseActivityFilters / serializeActivityFilters", () => {
  it("returns defaults for empty params", () => {
    const parsed = parseActivityFilters(new URLSearchParams());
    expect(parsed).toEqual(DEFAULT_ACTIVITY_FILTERS);
  });

  it("round-trips every filter dimension", () => {
    const filters: ActivityFilters = {
      asset: "USDC:GA5Z",
      participant: "GABC123",
      types: ["CREATED", "WITHDRAWN"],
      fromTimestamp: 1_700_000_000,
      toTimestamp: 1_700_100_000,
      search: "0xdead",
      sortField: "amount",
      sortDirection: "desc",
    };
    const params = serializeActivityFilters(filters);
    expect(parseActivityFilters(params)).toEqual(filters);
  });

  it("serializes defaults to an empty query string", () => {
    expect(serializeActivityFilters(DEFAULT_ACTIVITY_FILTERS).toString()).toBe(
      "",
    );
  });

  it("falls back to defaults for invalid values", () => {
    const params = new URLSearchParams({
      asset: "   ",
      participant: "",
      type: "NOT_A_TYPE",
      from: "not-a-number",
      to: "-5",
      sort: "bogus",
      dir: "sideways",
    });
    const parsed = parseActivityFilters(params);
    expect(parsed.asset).toBeUndefined();
    expect(parsed.participant).toBeUndefined();
    expect(parsed.types).toEqual([]);
    expect(parsed.fromTimestamp).toBeUndefined();
    expect(parsed.toTimestamp).toBeUndefined();
    expect(parsed.sortField).toBe(DEFAULT_ACTIVITY_FILTERS.sortField);
    expect(parsed.sortDirection).toBe(DEFAULT_ACTIVITY_FILTERS.sortDirection);
  });

  it("drops unknown event types but keeps valid ones", () => {
    const params = new URLSearchParams({ type: "CREATED,BOGUS,PAUSED" });
    expect(parseActivityFilters(params).types).toEqual(["CREATED", "PAUSED"]);
  });

  it("ignores inverted date ranges", () => {
    const params = new URLSearchParams({ from: "300", to: "100" });
    const parsed = parseActivityFilters(params);
    expect(parsed.fromTimestamp).toBeUndefined();
    expect(parsed.toTimestamp).toBeUndefined();
  });

  it("composes parsed filters with AND semantics", () => {
    const params = serializeActivityFilters({
      asset: "USDC:GA5Z",
      participant: "GABC123",
      types: ["WITHDRAWN"],
      fromTimestamp: 150,
      toTimestamp: 250,
    });
    const parsed = parseActivityFilters(params);
    const result = filterActivityEvents(events, parsed);
    expect(result.map((e) => e.id)).toEqual(["b"]);
  });

  it("yields empty results when filters match nothing", () => {
    const parsed = parseActivityFilters(
      new URLSearchParams({ search: "no-such-hash" }),
    );
    expect(filterActivityEvents(events, parsed)).toEqual([]);
  });
});

describe("cursor stability", () => {
  const base: ActivityFilters = {
    types: ["CREATED"],
    fromTimestamp: 100,
  };

  it("resets the cursor when filters change", () => {
    const next: ActivityFilters = { ...base, types: ["WITHDRAWN"] };
    expect(serializeActivityFilters(base).toString()).not.toBe(
      serializeActivityFilters(next).toString(),
    );
  });

  it("keeps the cursor stable when only the page changes", () => {
    const page1 = serializeActivityFilters(base);
    page1.set("cursor", "abc");
    const page2 = serializeActivityFilters(base);
    page2.set("cursor", "def");
    const strip = (p: URLSearchParams) => {
      const copy = new URLSearchParams(p);
      copy.delete("cursor");
      return copy.toString();
    };
    expect(strip(page1)).toBe(strip(page2));
  });
});
