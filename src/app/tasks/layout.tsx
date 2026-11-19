import ModuleGuardStartsEarly from '@/components/layout/ModuleGuardStartsEarly'

// Same module as /dashboard. The quotation sub-routes under /tasks keep their
// own PROTECTED-action checks (view_quotations / manage_quotations) on top of
// this one — module entry is the parent gate, not a replacement for them.
//
// The guard that lets the page START while the permission answer is on its way
// (2026-11-19): see ModuleGuardStartsEarly for what that does and does not change.
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuardStartsEarly moduleKey="task_management">{children}</ModuleGuardStartsEarly>
}
