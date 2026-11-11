import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import ListScreen from '@/components/quotations/ListScreen'

export default function QuotationsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ListScreen />
    </Suspense>
  )
}
