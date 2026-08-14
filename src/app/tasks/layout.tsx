import ModuleGuard from '@/components/layout/ModuleGuard'

// Same module as /dashboard. The quotation sub-routes under /tasks keep their
// own PROTECTED-action checks (view_quotations / manage_quotations) on top of
// this one — module entry is the parent gate, not a replacement for them.
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="task_management">{children}</ModuleGuard>
}
