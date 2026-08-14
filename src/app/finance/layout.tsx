import ModuleGuard from '@/components/layout/ModuleGuard'

// Finance entry now resolves through the permission engine instead of
// app_modules.visibility_type.
//
// WHAT CHANGED: this guard used to resolve entry from the legacy
// module-visibility table, which Access Control does not write. Switching an
// employee's Finance module access off therefore changed a stored override that
// nothing consulted, and the route stayed open. Entry is now effective
// `finance:view`.
//
// WHAT DID NOT CHANGE: everything inside. Finance's protected actions
// (approve / manage / delete / view_all) are still resolved per action by
// deriveFinanceCapabilities and still enforced by RLS and the approval RPCs.
// Record-level visibility is still ownership-scoped. This gate only decides
// whether the module opens at all.
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="finance">{children}</ModuleGuard>
}
