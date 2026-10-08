import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import RankingScreen from '@/components/exhibitionLeads/RankingScreen'

export default function ExhibitionLeadsRankingPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RankingScreen />
    </Suspense>
  )
}
