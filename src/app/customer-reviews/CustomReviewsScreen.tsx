'use client'

import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { CustomReviewSubmissions } from '@/components/customerReviews/CustomReviewSubmissions'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'

// A candidate's My Reviews during the Custom Review phase.
//
// ONE PRIMARY ACTION — Submit Custom Review — with the reward rules beside it,
// the candidate's Current Month and Last Month, and their own submissions with
// the correction path for a rejected one. Nothing from the generated-review
// workflow is read or offered here: no assigned cards, no Book.

export function CustomReviewsScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()

  if (loading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="My Reviews"
      subtitle="Submit custom reviews for approval"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>
        {profile && (
          <CustomReviewSubmissions supabase={supabase} profileId={profile.id} canSubmit={caps.canUse} />
        )}
      </div>
    </CustomerReviewsLayout>
  )
}
