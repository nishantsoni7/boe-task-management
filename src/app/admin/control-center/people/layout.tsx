import ModuleGuard from '@/components/layout/ModuleGuard'

// Employee administration, inside the Control Center shell.
//
// TWO GATES, BOTH KEPT. The Control Center's own layout already admits only a
// system administrator, and this adds back the `employee_records` module gate
// that /admin/members carried — so an administrator whose Access Control entry
// for Employee Records is switched off is refused here exactly as they were
// there. Neither gate is the boundary: every route this screen calls
// re-verifies the caller from the bearer token, and RLS decides the data.
export default function ControlCenterPeopleLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="employee_records">{children}</ModuleGuard>
}
