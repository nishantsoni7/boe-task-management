import ModuleGuard from '@/components/layout/ModuleGuard'
import { SalesCheckingFrame } from '@/components/salesLeads/SalesCheckingFrame'

// The gate every engine-gated module uses. Refused goes back to Modules: the shared /coming-soon page is
// hard-coded to Attendance, and would name the wrong module here. While the check runs the page's own frame is shown (static,
// no data, no actions) instead of the full-screen spinner: the Sales pages are open all day and this is the one place the
// rule "nothing renders before the access decision" is relaxed (owner, 2026-11-14).
export default function SalesRouteLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="sales" deniedRoute="/modules" checking={<SalesCheckingFrame />}>{children}</ModuleGuard>
}
