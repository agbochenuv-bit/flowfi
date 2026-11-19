"use client";

import { useState, useEffect, useMemo } from "react";
import { Copy, Check, LogOut, Moon, Sun, Bell, Globe, Volume2, Users, UserPlus, Trash2, ShieldAlert } from "lucide-react";
import { STELLAR_NETWORK, shortenPublicKey } from "@/lib/wallet";
import { useWallet } from "@/context/wallet-context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatNetwork } from "@/lib/wallet";
import toast from "react-hot-toast";
import { getApiBaseUrl } from "@/lib/api/_shared";
import { copyToClipboard } from "@/lib/clipboard";
import { DisconnectConfirmModal } from "@/components/wallet/DisconnectConfirmModal";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { SOUND_STORAGE_KEY } from "@/lib/transaction-feedback";

type DisplayCurrency = "USD" | "EUR" | "GBP" | "XLM" | "USDC";
type AmountFormat = "full" | "compact";
type DecimalPlaces = 2 | 4 | 7;

type OrgRole = "owner" | "admin" | "member" | "viewer";
type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

interface OrgMember {
  id: string;
  name: string;
  wallet: string;
  role: OrgRole;
}

interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  status: InvitationStatus;
  invitedBy: string;
  expiresAt: string;
}

interface OrgWorkspace {
  id: string;
  name: string;
  members: OrgMember[];
  invitations: OrgInvitation[];
}

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

const INVITATION_STATUS_STYLES: Record<InvitationStatus, string> = {
  pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  accepted: "bg-green-500/20 text-green-400 border-green-500/30",
  expired: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  revoked: "bg-red-500/20 text-red-400 border-red-500/30",
};

function canManageMembers(role: OrgRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

function canChangeRole(actorRole: OrgRole | undefined, targetRole: OrgRole): boolean {
  if (!canManageMembers(actorRole)) return false;
  // Only owners may promote/demote owners.
  if (targetRole === "owner") return actorRole === "owner";
  return true;
}

interface Settings {
  theme: "light" | "dark" | "system";
  displayCurrency: DisplayCurrency;
  amountFormat: AmountFormat;
  decimalPlaces: DecimalPlaces;
  transactionSounds: boolean;
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";
const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_STREAMING_CONTRACT || "CDV4K...7ZQY";
const INDEXER_URL = `${getApiBaseUrl()}/v1`;

const STORAGE_KEYS = {
  theme: "flowfi-theme",
  displayCurrency: "flowfi-currency",
  amountFormat: "flowfi-amount-format",
  decimalPlaces: "flowfi-decimal-places",
  transactionSounds: SOUND_STORAGE_KEY,
} as const;

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  displayCurrency: "USD",
  amountFormat: "full",
  decimalPlaces: 7,
  transactionSounds: false,
};

function loadSavedSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const savedDecimals = localStorage.getItem(STORAGE_KEYS.decimalPlaces);
  return {
    theme:
      (localStorage.getItem(STORAGE_KEYS.theme) as Settings["theme"]) ||
      DEFAULT_SETTINGS.theme,
    displayCurrency:
      (localStorage.getItem(STORAGE_KEYS.displayCurrency) as DisplayCurrency) ||
      DEFAULT_SETTINGS.displayCurrency,
    amountFormat:
      (localStorage.getItem(STORAGE_KEYS.amountFormat) as AmountFormat) ||
      DEFAULT_SETTINGS.amountFormat,
    decimalPlaces: savedDecimals
      ? (parseInt(savedDecimals, 10) as DecimalPlaces)
      : DEFAULT_SETTINGS.decimalPlaces,
    transactionSounds: localStorage.getItem(STORAGE_KEYS.transactionSounds) === "true",
  };
}

function applyThemeClass(theme: Settings["theme"]): void {
  if (typeof window === "undefined") return;
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

function persistSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEYS.theme, settings.theme);
  localStorage.setItem(STORAGE_KEYS.displayCurrency, settings.displayCurrency);
  localStorage.setItem(STORAGE_KEYS.amountFormat, settings.amountFormat);
  localStorage.setItem(STORAGE_KEYS.decimalPlaces, settings.decimalPlaces.toString());
  localStorage.setItem(STORAGE_KEYS.transactionSounds, String(settings.transactionSounds));
}

export default function SettingsContent() {
  const router = useRouter();
  const { session, disconnect, isHydrated } = useWallet();

  const [browserPush, setBrowserPush] = useState(false);
  const [draft, setDraft] = useState<Settings>(() => loadSavedSettings());
  const [saved, setSaved] = useState<Settings>(() => loadSavedSettings());
  const [lastLedger, setLastLedger] = useState<string>("Loading...");
  const [copied, setCopied] = useState(false);

  const [org, setOrg] = useState<OrgWorkspace | null>(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [signingBlocked, setSigningBlocked] = useState<string | null>(null);

  const currentMember = useMemo<OrgMember | undefined>(() => {
    if (!org || !session?.publicKey) return undefined;
    return org.members.find((m) => m.wallet === session.publicKey);
  }, [org, session?.publicKey]);

  const canManage = canManageMembers(currentMember?.role);

  useEffect(() => {
    let cancelled = false;
    const fetchOrg = async () => {
      setOrgLoading(true);
      setOrgError(null);
      try {
        const response = await fetch(`${INDEXER_URL}/organizations/current`);
        if (!response.ok) {
          throw new Error(`Request failed (${response.status})`);
        }
        const data = (await response.json()) as OrgWorkspace;
        if (!cancelled) setOrg(data);
      } catch {
        if (!cancelled) setOrgError("Unable to load your organization workspace.");
      } finally {
        if (!cancelled) setOrgLoading(false);
      }
    };
    fetchOrg();
    return () => {
      cancelled = true;
    };
  }, []);

  const guardSigning = (actingMember: OrgMember | undefined): boolean => {
    if (!session?.publicKey) {
      setSigningBlocked("Connect a wallet to perform organization actions.");
      return false;
    }
    if (!actingMember || actingMember.wallet !== session.publicKey) {
      setSigningBlocked(
        "Your connected wallet does not own this member. Signing on another wallet's behalf is not allowed."
      );
      return false;
    }
    setSigningBlocked(null);
    return true;
  };

  const handleInvite = () => {
    if (!org || !currentMember) return;
    if (!guardSigning(currentMember)) return;
    const email = inviteEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }
    if (org.invitations.some((i) => i.email === email && i.status === "pending")) {
      setInviteError("An invitation is already pending for this email.");
      return;
    }
    setInviteError(null);
    const invitation: OrgInvitation = {
      id: `inv-${Date.now()}`,
      email,
      role: inviteRole,
      status: "pending",
      invitedBy: currentMember.name,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    setOrg({ ...org, invitations: [invitation, ...org.invitations] });
    setInviteEmail("");
    toast.success("Invitation sent");
  };

  const handleRevokeInvitation = (id: string) => {
    if (!org || !currentMember) return;
    if (!guardSigning(currentMember)) return;
    setOrg({
      ...org,
      invitations: org.invitations.map((i) =>
        i.id === id ? { ...i, status: "revoked" as InvitationStatus } : i
      ),
    });
    toast.success("Invitation revoked");
  };

  const handleChangeRole = (memberId: string, role: OrgRole) => {
    if (!org || !currentMember) return;
    if (!guardSigning(currentMember)) return;
    const target = org.members.find((m) => m.id === memberId);
    if (!target || !canChangeRole(currentMember.role, target.role)) {
      toast.error("You do not have permission to change this role.");
      return;
    }
    setOrg({
      ...org,
      members: org.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
    });
    toast.success("Role updated");
  };

  const handleRemoveMember = (memberId: string) => {
    if (!org || !currentMember) return;
    if (!guardSigning(currentMember)) return;
    const target = org.members.find((m) => m.id === memberId);
    if (!target) return;
    if (target.role === "owner") {
      toast.error("The organization owner cannot be removed.");
      return;
    }
    setOrg({ ...org, members: org.members.filter((m) => m.id !== memberId) });
    toast.success("Member removed");
  };

  const isDirty = useMemo(
    () =>
      draft.theme !== saved.theme ||
      draft.displayCurrency !== saved.displayCurrency ||
      draft.amountFormat !== saved.amountFormat ||
      draft.decimalPlaces !== saved.decimalPlaces ||
      draft.transactionSounds !== saved.transactionSounds,
    [draft, saved]
  );

  // Covers tab close/refresh, internal link navigation, and back/forward
  useUnsavedChangesGuard(isDirty);

  // Apply the saved theme on mount
  useEffect(() => {
    applyThemeClass(draft.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeChange = (newTheme: Settings["theme"]) => {
    setDraft((prev) => ({ ...prev, theme: newTheme }));
    applyThemeClass(newTheme); // live preview; persisted on save
  };

  const handleSave = () => {
    persistSettings(draft);
    setSaved(draft);
    toast.success("Settings saved");
  };

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleDisconnect = () => {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Are you sure you want to disconnect?"
      );
      if (!confirmed) return;
    }
    disconnect();
    toast.success("Wallet disconnected");
    router.push("/");
  };

  const copyAddress = async () => {
    if (!session?.publicKey) return;
    const success = await copyToClipboard(session.publicKey, {
      successMessage: "Address copied to clipboard",
    });
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleBrowserPushToggle = async () => {
    if (!browserPush) {
      try {
        await Notification.requestPermission();
        setBrowserPush(Notification.permission === "granted");
        if (Notification.permission === "granted") {
          toast.success("Browser notifications enabled");
        }
      } catch {
        toast.error("Failed to enable notifications");
      }
    } else {
      setBrowserPush(false);
      toast("Browser notifications disabled");
    }
  };

  useEffect(() => {
    const fetchLastLedger = async () => {
      try {
        const response = await fetch(`${INDEXER_URL}/health`);
        if (response.ok) {
          const data = await response.json();
          if (data.ledger) {
            setLastLedger(data.ledger.toString());
          } else {
            setLastLedger("Unknown");
          }
        } else {
          setLastLedger("Unavailable");
        }
      } catch {
        setLastLedger("Error");
      }
    };
    fetchLastLedger();
  }, []);

  if (!isHydrated) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-black dark:from-white dark:via-gray-100 dark:to-gray-200 transition-colors flex items-center justify-center">
        <div className="text-white dark:text-black">Loading...</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-black dark:from-white dark:via-gray-100 dark:to-gray-200 transition-colors">

      {/* Background Glow */}
      <div className="absolute -top-40 -right-40 w-96 h-96 bg-purple-600/20 blur-3xl rounded-full" />
      <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-blue-600/20 blur-3xl rounded-full" />

      <div className="relative max-w-xl mx-auto px-6 py-20">
        <div className="rounded-3xl border border-white/10 dark:border-black/10 bg-white/5 dark:bg-black/5 backdrop-blur-2xl shadow-2xl p-10 space-y-10">

          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white dark:text-black">
              Settings
            </h1>
            <p className="text-sm opacity-60 mt-1">
              Manage your FlowFi preferences
            </p>
          </div>

          {/* Browser Push Notifications */}
          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400">
                <Bell size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Browser Notifications
                </p>
                <p className="text-sm opacity-60">
                  Get notified about stream activity
                </p>
              </div>
            </div>

            <button
              onClick={handleBrowserPushToggle}
              aria-label="Toggle browser notifications"
              aria-pressed={browserPush}
              className={`relative w-14 h-7 rounded-full transition-all duration-300 ${
                browserPush
                  ? "bg-gradient-to-r from-purple-500 to-blue-500"
                  : "bg-zinc-600"
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow-md transform transition duration-300 ${
                  browserPush
                    ? "translate-x-7"
                    : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Transaction Sound Effects */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/20 text-cyan-400">
                <Volume2 size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">Transaction Sounds</p>
                <p className="text-sm opacity-60">Play a short chime after a transaction succeeds</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDraft((prev) => ({ ...prev, transactionSounds: !prev.transactionSounds }))}
              aria-label="Toggle transaction sounds"
              aria-pressed={draft.transactionSounds}
              className={`relative w-14 h-7 rounded-full transition-colors ${draft.transactionSounds ? "bg-cyan-600" : "bg-zinc-600"}`}
            >
              <span className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${draft.transactionSounds ? "translate-x-7" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Theme Toggle */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                {draft.theme === "dark" ? <Moon size={18} /> : draft.theme === "light" ? <Sun size={18} /> : <Globe size={18} />}
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Appearance
                </p>
                <p className="text-sm opacity-60">
                  Choose your theme preference
                </p>
              </div>
            </div>

            <div className="flex gap-2">                  {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                    draft.theme === t
                      ? "border-purple-500 bg-purple-500/20 text-white"
                      : "border-white/10 dark:border-black/10 text-white/60 dark:text-black/60 hover:border-white/20"
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Display Preferences */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20 text-green-400">
                <Globe size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Display Preferences
                </p>
                <p className="text-sm opacity-60">
                  Customize how amounts are displayed
                </p>
              </div>
            </div>

            <div className="space-y-3 pl-12">
              <div>
                <label htmlFor="default-token" className="text-sm text-white/60 dark:text-black/60">Default Token</label>
                <select
                  id="default-token"
                  value={draft.displayCurrency}
                  onChange={(e) => {
                    const val = e.target.value as DisplayCurrency;
                    setDraft((prev) => ({ ...prev, displayCurrency: val }));
                  }}
                  className="mt-1 block w-full px-3 py-2 rounded-lg bg-black/40 dark:bg-white/40 border border-white/10 dark:border-black/10 text-white dark:text-black text-sm"
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="GBP">GBP (£)</option>
                  <option value="XLM">XLM</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>

              <div>
                <label id="amount-format-label" className="text-sm text-white/60 dark:text-black/60">Amount Format</label>
                <div
                  className="flex gap-2 mt-1"
                  role="radiogroup"
                  aria-labelledby="amount-format-label"
                >
                  {(["full", "compact"] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, amountFormat: fmt }))
                      }
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        draft.amountFormat === fmt
                          ? "border-blue-500 bg-blue-500/20 text-white"
                          : "border-white/10 text-white/60 hover:border-white/20"
                      }`}
                    >
                      {fmt === "full" ? "Full (1.0000000)" : "Compact (1.0)"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label id="decimal-places-label" className="text-sm text-white/60 dark:text-black/60">Decimal Places</label>
                <div
                  className="flex gap-2 mt-1"
                  role="radiogroup"
                  aria-labelledby="decimal-places-label"
                >
                  {([2, 4, 7] as DecimalPlaces[]).map((places) => (
                    <button
                      key={places}
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, decimalPlaces: places }))
                      }
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        draft.decimalPlaces === places
                          ? "border-green-500 bg-green-500/20 text-white"
                          : "border-white/10 text-white/60 hover:border-white/20"
                      }`}
                    >
                      {places} decimals
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Organization Workspace */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
                <Users size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">Organization Workspace</p>
                <p className="text-sm opacity-60">Team payroll, subscriptions, and roles</p>
              </div>
            </div>

            {signingBlocked && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              >
                <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" />
                <span>{signingBlocked}</span>
              </div>
            )}

            {orgLoading ? (
              <p className="text-sm opacity-60 pl-12">Loading workspace…</p>
            ) : orgError ? (
              <div
                role="alert"
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              >
                {orgError}
              </div>
            ) : !org ? (
              <p className="text-sm opacity-60 pl-12">No organization workspace found.</p>
            ) : (
              <div className="space-y-6 pl-12">
                <div>
                  <p className="text-sm font-medium text-white dark:text-black">{org.name}</p>
                  <p className="text-xs opacity-60">
                    {currentMember
                      ? `You are signed in as ${ROLE_LABELS[currentMember.role]}`
                      : "Your connected wallet is not a member of this workspace"}
                  </p>
                </div>

                {/* Members */}
                <div className="space-y-2">
                  <p className="text-sm text-white/60 dark:text-black/60">Members</p>
                  {org.members.length === 0 ? (
                    <p className="text-sm opacity-60">No members yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {org.members.map((member) => (
                        <li
                          key={member.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-white/10 dark:border-black/10 bg-black/30 dark:bg-white/30 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-white dark:text-black truncate">{member.name}</p>
                            <p className="text-xs font-mono opacity-60 truncate">{shortenPublicKey(member.wallet)}</p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {canManage && member.role !== "owner" ? (
                              <select
                                aria-label={`Role for ${member.name}`}
                                value={member.role}
                                onChange={(e) => handleChangeRole(member.id, e.target.value as OrgRole)}
                                className="px-2 py-1 rounded-lg bg-black/40 dark:bg-white/40 border border-white/10 dark:border-black/10 text-white dark:text-black text-xs"
                              >
                                {(["admin", "member", "viewer"] as OrgRole[]).map((r) => (
                                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs px-2 py-1 rounded-full border border-white/10 dark:border-black/10">
                                {ROLE_LABELS[member.role]}
                              </span>
                            )}
                            {canManage && member.role !== "owner" && (
                              <button
                                onClick={() => handleRemoveMember(member.id)}
                                aria-label={`Remove ${member.name}`}
                                className="opacity-60 hover:opacity-100 transition text-red-400"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Invitations */}
                <div className="space-y-2">
                  <p className="text-sm text-white/60 dark:text-black/60">Invitations</p>
                  {org.invitations.length === 0 ? (
                    <p className="text-sm opacity-60">No invitations yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {org.invitations.map((inv) => (
                        <li
                          key={inv.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-white/10 dark:border-black/10 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-white dark:text-black truncate">{inv.email}</p>
                            <p className="text-xs opacity-60">
                              {ROLE_LABELS[inv.role]} · invited by {inv.invitedBy}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-xs px-2 py-1 rounded-full border ${INVITATION_STATUS_STYLES[inv.status]}`}>
                              {inv.status}
                            </span>
                            {canManage && inv.status === "pending" && (
                              <button
                                onClick={() => handleRevokeInvitation(inv.id)}
                                className="text-xs text-red-400 hover:opacity-80 transition"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Invite form */}
                {canManage ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <UserPlus size={16} className="opacity-60" />
                      <p className="text-sm text-white/60 dark:text-black/60">Invite a teammate</p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => {
                          setInviteEmail(e.target.value);
                          setInviteError(null);
                        }}
                        placeholder="teammate@example.com"
                        aria-label="Invite email"
                        className="flex-1 px-3 py-2 rounded-lg bg-black/40 dark:bg-white/40 border border-white/10 dark:border-black/10 text-white dark:text-black text-sm"
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                        aria-label="Invite role"
                        className="px-3 py-2 rounded-lg bg-black/40 dark:bg-white/40 border border-white/10 dark:border-black/10 text-white dark:text-black text-sm"
                      >
                        {(["admin", "member", "viewer"] as OrgRole[]).map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleInvite}
                        className="px-4 py-2 text-sm rounded-xl font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition"
                      >
                        Invite
                      </button>
                    </div>
                    {inviteError && (
                      <p role="alert" className="text-xs text-red-400">{inviteError}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs opacity-60">
                    Only owners and admins can invite or manage members.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Save Changes */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 dark:border-black/10 bg-black/30 dark:bg-white/30 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-white dark:text-black">
                Save changes
              </p>
              <p className="text-xs opacity-60">
                {isDirty
                  ? "You have unsaved changes"
                  : "Your preferences are up to date"}
              </p>
            </div>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={`px-4 py-2 text-sm rounded-xl font-semibold transition-all ${
                isDirty
                  ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/25 cursor-pointer"
                  : "bg-white/10 text-white/40 dark:bg-black/10 dark:text-black/40 cursor-not-allowed"
              }`}
            >
              Save changes
            </button>
          </div>

          {/* Wallet Section */}
          {session ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-medium text-white dark:text-black">
                  Connected Wallet
                </p>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    {formatNetwork(session.network)}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
                    {session.walletName}
                  </span>
                </div>
              </div>

              <div className="relative flex items-center justify-between bg-black/40 dark:bg-white/40 px-5 py-4 rounded-xl font-mono text-sm break-all text-white dark:text-black border border-white/10 dark:border-black/10">
                <span className="pr-4">{session.publicKey}</span>

                <button
                  onClick={copyAddress}
                  aria-label={copied ? "Address copied" : "Copy wallet address"}
                  className="ml-3 opacity-70 hover:opacity-100 transition flex-shrink-0"
                >
                  {copied ? (
                    <Check size={18} className="text-green-400" />
                  ) : (
                    <Copy size={18} />
                  )}
                </button>

                {copied && (
                  <span className="absolute -top-8 right-2 text-xs bg-black text-white dark:bg-white dark:text-black px-2 py-1 rounded-md shadow">
                    Copied
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="font-medium text-white dark:text-black">
                Wallet Status
              </p>
              <div className="flex items-center justify-between bg-black/40 dark:bg-white/40 px-5 py-4 rounded-xl text-white dark:text-black border border-white/10 dark:border-black/10">
                <span>Not connected</span>
                <Link href="/" className="text-accent hover:opacity-80 transition font-semibold">
                  Connect Wallet
                </Link>
              </div>
            </div>
          )}

          {/* About Section */}
          <div className="space-y-4 pt-6 border-t border-white/10 dark:border-black/10">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-slate-500/20 text-slate-400">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4M12 8h.01"/>
                </svg>
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">About</p>
                <p className="text-sm opacity-60">App and contract information</p>
              </div>
            </div>

            <div className="space-y-3 pl-12">
              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">App Version</span>
                <span className="text-sm font-mono text-white dark:text-black">{APP_VERSION}</span>
              </div>

              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">Contract Address</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-white dark:text-black">{shortenPublicKey(CONTRACT_ADDRESS)}</span>
                  <button
                    onClick={() =>
                      copyToClipboard(CONTRACT_ADDRESS, {
                        successMessage: "Contract address copied",
                      })
                    }
                    aria-label="Copy contract address"
                    className="opacity-60 hover:opacity-100 transition"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">Network</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                  {STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet"}
                </span>
              </div>

              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-white/60 dark:text-black/60">Indexer Last Ledger</span>
                <span className="text-sm font-mono text-white dark:text-black">{lastLedger}</span>
              </div>
            </div>
          </div>

          {/* Disconnect */}
          {session && (
            <>
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="w-full flex items-center justify-center gap-2 bg-red-600/90 hover:bg-red-600 transition px-4 py-3 rounded-xl text-white font-medium shadow-lg hover:shadow-red-500/30"
              >
                <LogOut size={18} />
                Disconnect Wallet
              </button>

              {showDisconnectConfirm && (
                <DisconnectConfirmModal
                  onClose={() => setShowDisconnectConfirm(false)}
                  onConfirm={() => {
                    setShowDisconnectConfirm(false);
                    handleDisconnect();
                  }}
                  walletAddress={session.publicKey}
                />
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
