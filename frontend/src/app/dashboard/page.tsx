import { Suspense } from "react";
import { WalletEntry } from "@/components/wallet/wallet-entry";
import { RecurringScheduleManager } from "@/components/recurring/recurring-schedule-manager";

export default function AppDashboardPage() {
  return (
    <Suspense>
      <WalletEntry />
      <RecurringScheduleManager />
    </Suspense>
  );
}