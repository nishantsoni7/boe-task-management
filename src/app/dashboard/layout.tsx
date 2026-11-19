import ModuleGuardStartsEarly from '@/components/layout/ModuleGuardStartsEarly'

// Task Management's module route. `/` redirects to /modules, not here, so this
// gate removes a module — it is not the app's front door and cannot lock
// anybody out of the launcher.
//
// The guard that lets the page START while the permission answer is on its way
// (2026-11-19): see ModuleGuardStartsEarly for what that does and does not change.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuardStartsEarly moduleKey="task_management">{children}</ModuleGuardStartsEarly>
}
