import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LeadsListScreen from '@/components/exhibitionLeads/LeadsListScreen'

export default function AllExhibitionLeadsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LeadsListScreen mode="all" />
    </Suspense>
  )
}
