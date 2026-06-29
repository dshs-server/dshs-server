import { ToastProvider } from "@/components/toast";
import PortalShell from "../portal/PortalShell";

export default function AdminPage() {
  return (
    <ToastProvider>
      <PortalShell initialPage="admin" />
    </ToastProvider>
  );
}
