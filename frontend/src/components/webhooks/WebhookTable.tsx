"use client";

import { Activity, AlertTriangle, Pencil, Power, ShieldAlert, Trash2 } from "lucide-react";
import type { WebhookDeliveryHealth, WebhookSubscription } from "@/lib/api/webhooks";

interface Props { subscriptions: WebhookSubscription[]; onEdit: (subscription: WebhookSubscription) => void; onToggle: (subscription: WebhookSubscription) => void; onDelete: (subscription: WebhookSubscription) => void; onDeliveries: (subscription: WebhookSubscription) => void; onDiagnostics?: (subscription: WebhookSubscription) => void; healthById?: Record<string, WebhookDeliveryHealth>; healthError?: string | null; }

const HEALTH_STYLES: Record<WebhookDeliveryHealth["status"], string> = {
  healthy: "bg-emerald-400/15 text-emerald-300",
  degraded: "bg-amber-400/15 text-amber-300",
  failing: "bg-rose-400/15 text-rose-300",
  unknown: "bg-slate-400/15 text-slate-400",
};

const HEALTH_LABELS: Record<WebhookDeliveryHealth["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "No data",
};

function formatLastSuccess(health?: WebhookDeliveryHealth): string {
  if (!health?.lastSuccessAt) return "Never";
  const date = new Date(health.lastSuccessAt);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function HealthCell({ health, error }: { health?: WebhookDeliveryHealth; error?: string | null }) {
  if (error) {
    return <div className="flex items-center gap-2 text-xs text-amber-300"><AlertTriangle size={14} /><span>Health unavailable</span></div>;
  }
  if (!health) {
    return <span className="rounded-full bg-slate-400/15 px-2 py-1 text-xs text-slate-400">No data</span>;
  }
  return (
    <div className="space-y-1">
      <span className={`inline-block rounded-full px-2 py-1 text-xs ${HEALTH_STYLES[health.status] ?? HEALTH_STYLES.unknown}`}>{HEALTH_LABELS[health.status] ?? "No data"}</span>
      <div className="text-xs text-slate-400">Last success: {formatLastSuccess(health)}</div>
      {health.failureCategory && <div className="flex items-center gap-1 text-xs text-rose-300"><ShieldAlert size={12} /><span>{health.failureCategory}</span></div>}
    </div>
  );
}

export function WebhookTable({ subscriptions, onEdit, onToggle, onDelete, onDeliveries, onDiagnostics, healthById, healthError }: Props) {
  return <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">{healthError && <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3 text-xs text-amber-300"><AlertTriangle size={14} /><span>Delivery health could not be loaded: {healthError}</span></div>}<table className="w-full text-left text-sm"><thead className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-4">Endpoint</th><th className="px-5 py-4">Events</th><th className="px-5 py-4">Created</th><th className="px-5 py-4">Status</th><th className="px-5 py-4">Delivery health</th><th className="px-5 py-4 text-right">Actions</th></tr></thead><tbody className="divide-y divide-white/10">{subscriptions.map((subscription) => <tr key={subscription.id} className="text-slate-300"><td className="max-w-xs px-5 py-4"><div className="truncate font-mono text-xs">{subscription.targetUrl}</div><div className="mt-1 text-xs text-slate-500">{subscription.id}</div></td><td className="px-5 py-4"><div className="flex max-w-sm flex-wrap gap-1">{subscription.eventTypes.map((event) => <span key={event} className="rounded bg-white/10 px-2 py-1 text-[10px]">{event}</span>)}</div></td><td className="whitespace-nowrap px-5 py-4 text-slate-400">{new Date(subscription.createdAt).toLocaleDateString()}</td><td className="px-5 py-4"><span className={`rounded-full px-2 py-1 text-xs ${subscription.isActive ? "bg-emerald-400/15 text-emerald-300" : "bg-slate-400/15 text-slate-400"}`}>{subscription.isActive ? "Active" : "Inactive"}</span></td><td className="px-5 py-4"><HealthCell health={healthById?.[subscription.id]} error={healthError} /></td><td className="px-5 py-4"><div className="flex justify-end gap-2"><button onClick={() => onDeliveries(subscription)} aria-label="View delivery logs" title="View delivery logs"><Activity size={16} /></button>{onDiagnostics && <button onClick={() => onDiagnostics(subscription)} aria-label="View delivery diagnostics" title="View delivery diagnostics"><ShieldAlert size={16} /></button>}<button onClick={() => onEdit(subscription)} aria-label="Edit webhook" title="Edit webhook"><Pencil size={16} /></button><button onClick={() => onToggle(subscription)} aria-label="Toggle webhook" title="Toggle webhook"><Power size={16} /></button><button onClick={() => onDelete(subscription)} aria-label="Delete webhook" title="Delete webhook" className="text-rose-400"><Trash2 size={16} /></button></div></td></tr>)}</tbody></table>{subscriptions.length === 0 && <p className="p-10 text-center text-sm text-slate-400">No webhook endpoints registered yet.</p>}</div>;
}