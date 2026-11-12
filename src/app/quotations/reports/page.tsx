import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import ReportsScreen from '@/components/quotations/ReportsScreen'

export default function QuotationReportsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReportsScreen />
    </Suspense>
  )
}
