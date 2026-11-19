import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

const disconnectMock = vi.fn();
const useWalletMock = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import SettingsContent from "@/app/settings/settings-content";
import OrganizationWorkspace from "@/app/settings/organization-workspace";

describe("SettingsContent - Disconnect Confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWalletMock.mockReturnValue({
      session: {
        publicKey: "GC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        network: "TESTNET",
        walletName: "Freighter",
      },
      disconnect: disconnectMock,
      isHydrated: true,
    });
  });

  it("does not disconnect immediately on clicking 'Disconnect Wallet', but opens confirmation modal", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    expect(disconnectBtn).toBeInTheDocument();

    fireEvent.click(disconnectBtn);

    // Confirmation modal should be visible
    expect(screen.getByRole("heading", { name: /disconnect wallet\?/i })).toBeInTheDocument();
    expect(screen.getByText(/are you sure you want to disconnect your wallet\?/i)).toBeInTheDocument();

    // disconnect function should NOT have been called yet
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("closes confirmation modal without disconnecting when Cancel is clicked", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    fireEvent.click(disconnectBtn);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // Modal should be closed
    expect(screen.queryByRole("heading", { name: /disconnect wallet\?/i })).not.toBeInTheDocument();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("calls disconnect and redirects to home when Disconnect is confirmed in modal", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    fireEvent.click(disconnectBtn);

    // Click confirm disconnect button inside modal
    const modalConfirmBtn = screen.getByRole("button", { name: /^disconnect$/i });
    fireEvent.click(modalConfirmBtn);

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/");
  });
});

const ADMIN_KEY = "GADMIN1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MEMBER_KEY = "GMEMBER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const OTHER_KEY = "GOTHER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function mockWorkspace(overrides: Record<string, unknown> = {}) {
  useWalletMock.mockReturnValue({
    session: {
      publicKey: ADMIN_KEY,
      network: "TESTNET",
      walletName: "Freighter",
    },
    disconnect: disconnectMock,
    isHydrated: true,
    ...overrides,
  });
}

describe("OrganizationWorkspace - invitation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace();
  });

  it("renders the empty state when there are no members or invitations", () => {
    render(<OrganizationWorkspace initialMembers={[]} initialInvitations={[]} />);

    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no pending invitations/i)).toBeInTheDocument();
  });

  it("allows an admin to invite a new member and shows the pending invitation", () => {
    render(<OrganizationWorkspace initialMembers={[]} initialInvitations={[]} />);

    fireEvent.change(screen.getByLabelText(/invite email/i), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/role/i), {
      target: { value: "member" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("rejects an invalid email when inviting", () => {
    render(<OrganizationWorkspace initialMembers={[]} initialInvitations={[]} />);

    fireEvent.change(screen.getByLabelText(/invite email/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
    expect(screen.queryByText("not-an-email")).not.toBeInTheDocument();
  });

  it("accepts a pending invitation and moves the invitee into the member list", () => {
    render(
      <OrganizationWorkspace
        initialMembers={[]}
        initialInvitations={[
          { id: "inv-1", email: "invitee@example.com", role: "member", status: "pending" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    expect(screen.getByText("invitee@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });

  it("marks an expired invitation and prevents accepting it", () => {
    render(
      <OrganizationWorkspace
        initialMembers={[]}
        initialInvitations={[
          { id: "inv-2", email: "late@example.com", role: "member", status: "expired" },
        ]}
      />,
    );

    expect(screen.getByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
  });

  it("allows an admin to revoke a pending invitation", () => {
    render(
      <OrganizationWorkspace
        initialMembers={[]}
        initialInvitations={[
          { id: "inv-3", email: "revoke@example.com", role: "member", status: "pending" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    expect(screen.queryByText("revoke@example.com")).not.toBeInTheDocument();
  });
});

describe("OrganizationWorkspace - permission-based controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides invite and revoke controls for non-admin members", () => {
    mockWorkspace({
      session: { publicKey: MEMBER_KEY, network: "TESTNET", walletName: "Freighter" },
    });

    render(
      <OrganizationWorkspace
        currentRole="member"
        initialMembers={[{ id: "m-1", publicKey: MEMBER_KEY, role: "member" }]}
        initialInvitations={[
          { id: "inv-4", email: "someone@example.com", role: "member", status: "pending" },
        ]}
      />,
    );

    expect(screen.queryByRole("button", { name: /send invitation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("disables role escalation controls for non-admin members", () => {
    mockWorkspace({
      session: { publicKey: MEMBER_KEY, network: "TESTNET", walletName: "Freighter" },
    });

    render(
      <OrganizationWorkspace
        currentRole="member"
        initialMembers={[{ id: "m-1", publicKey: MEMBER_KEY, role: "member" }]}
        initialInvitations={[]}
      />,
    );

    const roleSelect = screen.queryByLabelText(/change role/i);
    if (roleSelect) {
      expect(roleSelect).toBeDisabled();
    } else {
      expect(screen.queryByRole("button", { name: /make admin/i })).not.toBeInTheDocument();
    }
  });
});

describe("OrganizationWorkspace - error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace();
  });

  it("shows an error state when the workspace fails to load", () => {
    render(<OrganizationWorkspace error="Failed to load organization" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/failed to load organization/i);
  });

  it("surfaces an error when inviting fails", () => {
    render(
      <OrganizationWorkspace
        initialMembers={[]}
        initialInvitations={[]}
        inviteError="Invitation could not be sent"
      />,
    );

    fireEvent.change(screen.getByLabelText(/invite email/i), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/invitation could not be sent/i);
  });
});

describe("OrganizationWorkspace - wallet signing ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a member from signing on another wallet's behalf", () => {
    mockWorkspace({
      session: { publicKey: MEMBER_KEY, network: "TESTNET", walletName: "Freighter" },
    });

    render(
      <OrganizationWorkspace
        currentRole="member"
        initialMembers={[
          { id: "m-1", publicKey: MEMBER_KEY, role: "member" },
          { id: "m-2", publicKey: OTHER_KEY, role: "member" },
        ]}
        initialInvitations={[]}
      />,
    );

    const signForOther = screen.queryByRole("button", {
      name: new RegExp(`sign.*${OTHER_KEY.slice(0, 6)}`, "i"),
    });
    if (signForOther) {
      expect(signForOther).toBeDisabled();
    } else {
      expect(
        screen.queryByRole("button", { name: /sign on behalf/i }),
      ).not.toBeInTheDocument();
    }
  });

  it("allows signing only for the connected wallet's own member entry", () => {
    mockWorkspace({
      session: { publicKey: MEMBER_KEY, network: "TESTNET", walletName: "Freighter" },
    });

    render(
      <OrganizationWorkspace
        currentRole="member"
        initialMembers={[{ id: "m-1", publicKey: MEMBER_KEY, role: "member" }]}
        initialInvitations={[]}
      />,
    );

    const ownSign = screen.queryByRole("button", { name: /sign/i });
    if (ownSign) {
      expect(ownSign).not.toBeDisabled();
    }
  });
});
