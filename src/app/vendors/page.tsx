import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import VendorListScreen from '@/components/vendors/VendorListScreen'

export default function VendorsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <VendorListScreen />
    </Suspense>
  )
}
