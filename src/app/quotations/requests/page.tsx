import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import RequestsScreen from '@/components/quotations/RequestsScreen'

export default function QuotationRequestsInQuotationsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RequestsScreen />
    </Suspense>
  )
}
