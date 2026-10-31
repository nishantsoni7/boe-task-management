import ModuleGuard from '@/components/layout/ModuleGuard'

// The gate every engine-gated module uses. Refused goes back to Modules: the shared /coming-soon page is
// hard-coded to Attendance, and would name the wrong module here.
export default function PricingRouteLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="pricing" deniedRoute="/modules">{children}</ModuleGuard>
}
