import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const useWalletMock = vi.fn();
const useNetworkMock = vi.fn();
const switchNetworkMock = vi.fn();
const hasPendingActionsMock = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("@/context/network-context", () => ({
  useNetwork: () => useNetworkMock(),
}));

vi.mock("@/components/wallet/WalletModal", () => ({
  WalletModal: () => <div data-testid="wallet-modal">connect your wallet</div>,
}));

vi.mock("@/components/dashboard/dashboard-view", () => ({
  DashboardView: () => <div data-testid="dashboard-view">dashboard</div>,
}));

import { WalletEntry } from "../components/wallet/wallet-entry";

const NETWORKS = [
  { id: "testnet", label: "Testnet", passphrase: "Test SDF Network ; September 2015" },
  { id: "mainnet", label: "Mainnet", passphrase: "Public Global Stellar Network ; September 2015" },
];

function mockConnectedWallet(overrides: Record<string, unknown> = {}) {
  useWalletMock.mockReturnValue({
    status: "connected",
    session: { publicKey: "GABC", network: "testnet" },
    isHydrated: true,
    disconnect: vi.fn(),
    ...overrides,
  });
}

function mockNetwork(overrides: Record<string, unknown> = {}) {
  useNetworkMock.mockReturnValue({
    activeNetwork: NETWORKS[0],
    networks: NETWORKS,
    switchNetwork: switchNetworkMock,
    hasPendingActions: hasPendingActionsMock,
    ...overrides,
  });
}

describe("WalletEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPendingActionsMock.mockReturnValue(false);
    switchNetworkMock.mockResolvedValue(undefined);
  });

  it("shows a loading state before hydration instead of the dashboard or modal", () => {
    useWalletMock.mockReturnValue({
      status: "disconnected",
      session: null,
      isHydrated: false,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByText(/loading wallet session/i)).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-view")).not.toBeInTheDocument();
  });

  it("prompts wallet connection when hydrated with no active session", () => {
    useWalletMock.mockReturnValue({
      status: "disconnected",
      session: null,
      isHydrated: true,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-view")).not.toBeInTheDocument();
  });

  it("renders the dashboard when hydrated with a connected session", () => {
    useWalletMock.mockReturnValue({
      status: "connected",
      session: { publicKey: "GABC" },
      isHydrated: true,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-modal")).not.toBeInTheDocument();
  });

  it("displays the active network so stale configuration is visible", () => {
    mockConnectedWallet();
    mockNetwork();

    render(<WalletEntry />);

    expect(screen.getByTestId("active-network")).toHaveTextContent("Testnet");
  });

  it("switches network without confirmation when there are no pending actions", () => {
    mockConnectedWallet();
    mockNetwork();

    render(<WalletEntry />);

    fireEvent.click(screen.getByRole("button", { name: /switch to mainnet/i }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(switchNetworkMock).toHaveBeenCalledWith("mainnet");
  });

  it("requires explicit confirmation when switching with pending actions", () => {
    mockConnectedWallet();
    mockNetwork();
    hasPendingActionsMock.mockReturnValue(true);

    render(<WalletEntry />);

    fireEvent.click(screen.getByRole("button", { name: /switch to mainnet/i }));

    expect(switchNetworkMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(switchNetworkMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switches network after the user confirms pending-action warning", () => {
    mockConnectedWallet();
    mockNetwork();
    hasPendingActionsMock.mockReturnValue(true);

    render(<WalletEntry />);

    fireEvent.click(screen.getByRole("button", { name: /switch to mainnet/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(switchNetworkMock).toHaveBeenCalledWith("mainnet");
  });

  it("isolates cached data per network so stale contract config is not reused", () => {
    mockConnectedWallet();
    mockNetwork();

    const { rerender } = render(<WalletEntry />);

    expect(screen.getByTestId("dashboard-view")).toHaveAttribute(
      "data-network",
      "testnet",
    );

    mockNetwork({ activeNetwork: NETWORKS[1] });
    rerender(<WalletEntry />);

    expect(screen.getByTestId("dashboard-view")).toHaveAttribute(
      "data-network",
      "mainnet",
    );
  });

  it("warns and blocks actions when the wallet network does not match the active network", () => {
    mockConnectedWallet({ session: { publicKey: "GABC", network: "mainnet" } });
    mockNetwork();

    render(<WalletEntry />);

    expect(screen.getByRole("alert")).toHaveTextContent(/network mismatch/i);
    expect(screen.queryByTestId("dashboard-view")).not.toBeInTheDocument();
  });

  it("preserves route state when switching networks", () => {
    mockConnectedWallet();
    mockNetwork();

    render(<WalletEntry />);

    fireEvent.click(screen.getByRole("button", { name: /switch to mainnet/i }));

    expect(switchNetworkMock).toHaveBeenCalledWith("mainnet");
    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
  });
});
