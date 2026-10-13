import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import RequestsScreen from '@/components/inventory/RequestsScreen'

export default function InventoryRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RequestsScreen />
    </Suspense>
  )
}
