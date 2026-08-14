import ModuleGuard from '@/components/layout/ModuleGuard'

// Covers /performance and /performance/team. The team route stays authorized
// server-side against the real caller as well — this gate is additive to it,
// never a substitute.
export default function PerformanceLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="performance">{children}</ModuleGuard>
}
