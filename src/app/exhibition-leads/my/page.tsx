import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import LeadsListScreen from '@/components/exhibitionLeads/LeadsListScreen'

// useSearchParams (the list state lives in the URL) needs a Suspense boundary.
export default function MyExhibitionLeadsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LeadsListScreen mode="mine" />
    </Suspense>
  )
}
