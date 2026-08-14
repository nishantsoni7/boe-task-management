import ModuleGuard from '@/components/layout/ModuleGuard'

// Task Management's module route. `/` redirects to /modules, not here, so this
// gate removes a module — it is not the app's front door and cannot lock
// anybody out of the launcher.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="task_management">{children}</ModuleGuard>
}
