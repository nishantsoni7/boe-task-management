import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import BuilderScreen from '@/components/quotations/BuilderScreen'

export default function QuotationPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <BuilderScreen />
    </Suspense>
  )
}
