'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { EmployeeProgress } from '@/components/customerReviews/EmployeeProgress'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'

// Per-employee progress, as a workspace of its own.
//
// It used to sit in a collapsed foldaway above the review queue. It reads every
// assigned review to count them, which is real work to do on a page somebody
// opened to look at twelve drafts — so it now happens only when somebody asks
// this question.
//
// STILL NOT A DASHBOARD. Four counts and a type split per person. No ranking,
// no score, no chart; the sort puts the most outstanding work first because
// that is the reason to open the page.
export function ProgressScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  if (loading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Progress"
      subtitle="Assigned, posted, verified and remaining"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '900px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <EmployeeProgress supabase={supabase} />
        <p style={{ margin: 0, fontSize: '11px', color: colors.muted, lineHeight: 1.6 }}>
          Sorted by outstanding work. Text and Image show posted of assigned.
        </p>
      </div>
    </CustomerReviewsLayout>
  )
}
