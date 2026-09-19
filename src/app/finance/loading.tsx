import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'

// Every Finance route, while its code or server payload is on the way: the
// Finance shell with the destination lit and titled, and a skeleton body. It
// sits INSIDE ModuleGuard (layout.tsx), so nothing here renders before module
// access is decided, and it reads no data of its own. See ModuleRouteFallback.
export default function FinanceLoading() {
  return <FinanceRouteFallback />
}
