import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LearningBatch from '@/components/pricing/learning/LearningBatch'

export default function PriceLearningBatchPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LearningBatch />
    </Suspense>
  )
}
