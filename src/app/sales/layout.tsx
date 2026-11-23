import ModuleGuardStartsEarly from '@/components/layout/ModuleGuardStartsEarly'
import { SalesCheckingFrame } from '@/components/salesLeads/SalesCheckingFrame'

// The gate every engine-gated module uses. Refused goes back to Modules: the shared /coming-soon page is
// hard-coded to Attendance, and would name the wrong module here.
//
// While the check runs the page's own frame is shown (static, no data, no actions) instead of the full-screen spinner (owner,
// 2026-11-14), and since 2026-11-23 the page itself is built HIDDEN behind that frame, so its reads start at once instead of
// after the check (page speed, the same guard Task Management has used since 2026-11-19: see ModuleGuardStartsEarly for what
// that does and does not change). Every Sales read is a database function that checks the caller's access itself, so a
// person who is turned away has had nothing returned to them.
export default function SalesRouteLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuardStartsEarly moduleKey="sales" deniedRoute="/modules" checking={<SalesCheckingFrame />}>{children}</ModuleGuardStartsEarly>
}
