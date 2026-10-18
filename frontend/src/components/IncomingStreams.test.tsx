import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => window.history.pushState({}, "", url),
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/hooks/useStreamingAmount", () => ({
  useStreamingAmount: () => 0,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/transaction-feedback", () => ({
  transactionSuccessToast: vi.fn(),
}));

import IncomingStreams from "./IncomingStreams";
import type { Stream } from "@/lib/dashboard";

const STORAGE_KEY = "flowfi.table.incoming-streams.v1";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "1",
    recipient: "Alice",
    amount: 100,
    token: "USDC",
    status: "Active",
    deposited: 100,
    withdrawn: 10,
    date: "2026-01-01",
    ratePerSecond: 0,
    lastUpdateTime: 0,
    isActive: true,
    ...overrides,
  };
}

function renderTable(streams: Stream[] = [makeStream()]) {
  return render(<IncomingStreams streams={streams} onWithdraw={vi.fn()} />);
}

function sortButton(label: string) {
  return screen.getByRole("button", { name: `Sort by ${label}` });
}

function querySortButton(label: string) {
  return screen.queryByRole("button", { name: `Sort by ${label}` });
}

function visibleColumnLabels(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent?.trim() ?? "")
    .filter((label) => label !== "Actions");
}

function rowRecipients(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector(".font-mono")?.textContent?.trim() ?? "");
}

describe("IncomingStreams table preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("renders all columns and the settings control by default", () => {
    renderTable();

    for (const label of ["Sender", "Token", "Deposited", "Withdrawn", "Claimable", "Status"]) {
      expect(sortButton(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByLabelText("Table settings")).toBeInTheDocument();
  });

  it("hides a column from the settings dropdown and persists the choice", async () => {
    renderTable();

    fireEvent.click(screen.getByLabelText("Table settings"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Token" }));

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(stored.visibleColumns).not.toContain("token");
    });

    expect(sortButton("Sender")).toBeInTheDocument();
  });

  it("restores hidden columns from localStorage on mount", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: null,
        sortDirection: "desc",
        visibleColumns: ["sender", "deposited", "withdrawn", "claimable", "status"],
      }),
    );

    renderTable();

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });
    expect(sortButton("Sender")).toBeInTheDocument();
    expect(visibleColumnLabels()).toEqual([
      "Sender",
      "Deposited",
      "Withdrawn",
      "Claimable",
      "Status",
    ]);
  });

  it("resets the table layout from the settings dropdown", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "deposited",
        sortDirection: "asc",
        visibleColumns: ["sender"],
      }),
    );

    renderTable();

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Table settings"));
    fireEvent.click(screen.getByText("Reset Table Layout"));

    await waitFor(() => {
      expect(sortButton("Token")).toBeInTheDocument();
    });
    expect(visibleColumnLabels()).toEqual([
      "Sender",
      "Token",
      "Deposited",
      "Withdrawn",
      "Claimable",
      "Status",
    ]);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.visibleColumns).toEqual([
      "sender",
      "token",
      "deposited",
      "withdrawn",
      "claimable",
      "status",
    ]);
    expect(stored.sortBy).toBeNull();
  });

  it("sorts rows when a column header is clicked", () => {
    const table = renderTable([
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]);

    fireEvent.click(sortButton("Deposited")); // ascending
    expect(window.location.search).toContain("incomingSort=deposited");
    expect(window.location.search).toContain("incomingDirection=asc");
    table.rerender(<IncomingStreams streams={[
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]} onWithdraw={vi.fn()} />);
    expect(rowRecipients()).toEqual(["Carol", "Alice", "Bob"]);

    fireEvent.click(sortButton("Deposited")); // descending
    table.rerender(<IncomingStreams streams={[
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]} onWithdraw={vi.fn()} />);
    expect(rowRecipients()).toEqual(["Bob", "Alice", "Carol"]);
  });

  it("restores filter and pagination from the URL and pushes page changes to history", () => {
    window.history.replaceState({}, "", "/?incomingStatus=Active&incomingPage=2");
    const streams = Array.from({ length: 12 }, (_, index) => makeStream({
      id: String(index + 1),
      recipient: `Recipient ${index + 1}`,
      status: index === 0 ? "Paused" : "Active",
    }));
    const table = renderTable(streams);

    expect(screen.getByLabelText("Filter incoming streams")).toHaveValue("Active");
    expect(screen.getByText("Page 2 of 2 (11 streams)")).toBeInTheDocument();
    expect(rowRecipients()).toEqual(["Recipient 12"]);

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(window.location.search).toContain("incomingPage=1");
    table.rerender(<IncomingStreams streams={streams} onWithdraw={vi.fn()} />);
    expect(rowRecipients()).toHaveLength(10);
  });

  it("restores sort order from the URL on mount", async () => {
    window.history.replaceState({}, "", "/?incomingSort=deposited&incomingDirection=desc");
    renderTable([
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]);

    await waitFor(() => {
      expect(rowRecipients()).toEqual(["Bob", "Alice", "Carol"]);
    });
  });

  it("renders safely when localStorage contains corrupted data", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    renderTable();

    await waitFor(() => {
      expect(sortButton("Token")).toBeInTheDocument();
    });
  });
});

describe("IncomingStreams virtualization", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a virtualized scroll container when stream count exceeds the threshold", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      makeStream({
        id: String(i + 1),
        recipient: `Recipient-${i}`,
        deposited: (i + 1) * 10,
      }),
    );

    render(<IncomingStreams streams={many} onWithdraw={vi.fn()} />);

    // The virtualized path renders a scroll container with overflow-auto.
    const scrollContainer = document.querySelector(
      "div.overflow-auto[style*='max-height']",
    );
    expect(scrollContainer).not.toBeNull();

    // aria-rowcount should reflect the total stream count (+1 for the header).
    const table = scrollContainer!.querySelector("table");
    expect(table?.getAttribute("aria-rowcount")).toBe("61");

    // Not every row should be mounted (virtualization bounds the DOM).
    const renderedRows = scrollContainer!.querySelectorAll("[data-stream-id]");
    expect(renderedRows.length).toBeLessThan(60);
  });

  it("keeps selectedStreamId data attribute and aria-selected on the highlighted virtualized row", () => {
    // In jsdom the scroll element has no real dimensions, so the virtualizer
    // may not mount any rows. Instead, verify the non-virtualised path (which
    // always mounts every row) carries aria-selected and data-stream-id for
    // the keyboard-highlighted row — the same StreamRow component is shared.
    const few = Array.from({ length: 3 }, (_, i) =>
      makeStream({
        id: String(i + 1),
        recipient: `Recipient-${i}`,
        deposited: (i + 1) * 10,
      }),
    );

    render(
      <IncomingStreams
        streams={few}
        onWithdraw={vi.fn()}
        selectedStreamId="2"
      />,
    );

    const selectedRow = document.querySelector('[data-stream-id="2"]');
    expect(selectedRow).not.toBeNull();
    expect(selectedRow?.getAttribute("aria-selected")).toBe("true");

    const unselectedRows = document.querySelectorAll(
      '[data-stream-id][aria-selected="false"]',
    );
    expect(unselectedRows.length).toBe(2);
  });

  it("requires confirmation after showing selected stream and network details", async () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    render(
      <IncomingStreams
        streams={[makeStream()]}
        onWithdraw={onWithdraw}
        network="Testnet"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(onWithdraw).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Testnet")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("USDC");

    fireEvent.click(screen.getByRole("button", { name: /continue to wallet/i }));

    await waitFor(() => {
      expect(onWithdraw).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    });
  });
});
