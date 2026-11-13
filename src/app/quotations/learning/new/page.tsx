import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LearningNew from '@/components/pricing/learning/LearningNew'

export default function PriceLearningNewPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LearningNew />
    </Suspense>
  )
}
