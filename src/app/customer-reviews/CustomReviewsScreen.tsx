'use client'

import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { CustomReviewSubmissions } from '@/components/customerReviews/CustomReviewSubmissions'
import { ReviewsLeaderboardPanel } from '@/components/customerReviews/ReviewsLeaderboardPanel'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'

// The Reviews landing page for everyone with access: the monthly leaderboard, then
// the custom-review workspace.
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
      subtitle="Leaderboard, submit review and your reviews"
      canVerify={caps.canVerify}
      actions={caps.canUse ? (
        <button
          type="button"
          className="boe-btn boe-btn-primary"
          onClick={() => document.getElementById('submit-custom-review')?.click()}
          style={{ minHeight: '44px', padding: '8px 14px', fontSize: '13px' }}
        >
          Submit review
        </button>
      ) : undefined}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px', minWidth: 0 }}>
        <ReviewsLeaderboardPanel />
        {profile && (
          <CustomReviewSubmissions supabase={supabase} profileId={profile.id} canSubmit={caps.canUse} />
        )}
      </div>
    </CustomerReviewsLayout>
  )
}
