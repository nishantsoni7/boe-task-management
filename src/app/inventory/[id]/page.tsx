import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import ProductDetailScreen from '@/components/inventory/ProductDetailScreen'

export default function ProductPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ProductDetailScreen />
    </Suspense>
  )
}
