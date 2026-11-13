'use client'

import { ReviewRankingsSetting } from '@/components/controlCenter/ReviewRankingsSetting'

// Control Center › Reviews › Rankings. Admin gating is the Control Center layout's;
// set_review_rankings_visible repeats it in the database for every change.
export default function ControlCenterReviewRankingsPage() {
  return <ReviewRankingsSetting />
}
