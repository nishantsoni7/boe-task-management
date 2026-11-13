import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LearningHome from '@/components/pricing/learning/LearningHome'

export default function PriceLearningPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LearningHome />
    </Suspense>
  )
}
