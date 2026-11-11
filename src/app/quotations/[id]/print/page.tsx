import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { PrintScreen } from '@/components/quotations/DocumentScreens'

export default function QuotationPrintPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PrintScreen />
    </Suspense>
  )
}
