import ModuleGuard from '@/components/layout/ModuleGuard'

// Employee Records. The page's own `role !== 'admin'` bounce stays exactly as
// it was; this gate sits in front of it, so the module is additionally closed
// to anyone whose Access Control entry is switched off. Admins short-circuit
// both checks.
export default function AdminMembersLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="employee_records">{children}</ModuleGuard>
}
