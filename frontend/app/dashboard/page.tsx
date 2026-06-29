import { ToastProvider } from "@/components/toast";
import PortalShell from "../portal/PortalShell";

export default function DashboardPage() {
  return (
    <ToastProvider>
      <PortalShell initialPage="work" />
    </ToastProvider>
  );
}
