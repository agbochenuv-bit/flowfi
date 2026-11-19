"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api/_shared";
import { authenticatedFetch } from "@/lib/auth";

interface Props {
  token: string;
}

export default function PrivacyControls({ token }: Props) {
  const [pending, setPending] = useState(false);
  const [confirmDeletion, setConfirmDeletion] = useState(false);
  const [message, setMessage] = useState("");

  async function requestData(operation: "export" | "deletion") {
    setPending(true);
    setMessage("");
    const base = getApiBaseUrl().replace(/(?:\/api)?\/v1$|\/api$/, "");
    try {
      const response = await authenticatedFetch(`${base}/v1/privacy/${operation}`, {
        method: "POST",
        ...(operation === "deletion" && {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        }),
      }, token);
      if (!response.ok) throw new Error("Privacy request failed");
      if (operation === "export") {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = "flowfi-data-export.json";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("Your data export is ready.");
      } else {
        const { receipt } = await response.json();
        setConfirmDeletion(false);
        setMessage(`Deletion complete. Removed ${receipt.subscriptions} webhook subscriptions and ${receipt.deliveries} delivery records. Receipt ${receipt.id}.`);
      }
    } catch {
      setMessage("Completion could not be confirmed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 border-t border-white/10 pt-5" aria-label="Wallet data privacy">
      <h2 className="font-semibold">Wallet data privacy</h2>
      <p className="text-sm">
        Export or delete webhook settings and delivery history. Public Stellar history and completion receipts are retained.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="rounded-lg border px-4 py-2" disabled={pending}
          onClick={() => void requestData("export")}>
          Download data
        </button>
        <button type="button" className="rounded-lg border px-4 py-2" disabled={pending}
          onClick={() => setConfirmDeletion(true)}>
          Delete webhook data
        </button>
      </div>
      {confirmDeletion && (
        <div className="space-y-2">
          <p>This permanently removes your webhook subscriptions and their delivery history.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-lg border px-4 py-2" disabled={pending}
              onClick={() => void requestData("deletion")}>
              Confirm deletion
            </button>
            <button type="button" className="rounded-lg border px-4 py-2" disabled={pending}
              onClick={() => setConfirmDeletion(false)}>
              Keep data
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite">{pending ? "Processing privacy request…" : message}</p>
    </section>
  );
}
