'use client'

import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { CustomReviewSubmissions } from '@/components/customerReviews/CustomReviewSubmissions'
import { ReviewsLeaderboardPanel } from '@/components/customerReviews/ReviewsLeaderboardPanel'
import { SubmitControlProvider, SubmitReviewHeaderButton } from '@/components/customerReviews/CustomReviewSubmitControl'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { useReviewRankings } from '@/hooks/queries/useReviewRankings'

// The Reviews landing page for everyone with access: the custom-review workspace,
// then (only while an administrator has the ranking switched on) the monthly
// leaderboard at the bottom. The ranking never leads the page.
//
// ONE PRIMARY ACTION — Submit Custom Review — with the reward rules beside it,
// the candidate's Current Month and Last Month, and their own submissions with
// the correction path for a rejected one. Nothing from the generated-review
// workflow is read or offered here: no assigned cards, no Book.

export function CustomReviewsScreen() {
  return (
    <SubmitControlProvider>
      <LandingScreen />
    </SubmitControlProvider>
  )
}

function LandingScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const rankings = useReviewRankings()

  if (loading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="My Reviews"
      subtitle={rankings.visible ? 'Submit a review, your reviews and the leaderboard' : 'Submit a review and your reviews'}
      canVerify={caps.canVerify}
      actions={caps.canUse ? <SubmitReviewHeaderButton /> : undefined}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px', minWidth: 0 }}>
        {profile && (
          <CustomReviewSubmissions supabase={supabase} profileId={profile.id} canSubmit={caps.canUse} />
        )}
        <ReviewsLeaderboardPanel />
      </div>
    </CustomerReviewsLayout>
  )
}
