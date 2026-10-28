import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LogVisitScreen from '@/components/vendors/LogVisitScreen'

export default function LogVendorVisitPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LogVisitScreen />
    </Suspense>
  )
}
