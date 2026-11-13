'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CcBadge, CcSection, cc } from './CcPrimitives'
import { saveRankingsVisible, useReviewRankings, type RankingsRead } from '@/hooks/queries/useReviewRankings'
import { REVIEW_RANKINGS_KEY } from '@/lib/customerReviews/rankingsSwitch'

// Control Center › Reviews › Rankings (20270702000000): one switch for the review
// leaderboard, for every employee. It starts hidden.
//
// The write is set_review_rankings_visible(), which refuses anyone but an active
// administrator; this screen is only the control. It shows the switch as it is
// SAVED, and will not offer a change it could not read the current state for.
export function ReviewRankingsSetting() {
  const queryClient = useQueryClient()
  const { visible, known, failed } = useReviewRankings()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const choose = async (next: boolean) => {
    const before = queryClient.getQueryData<RankingsRead>(REVIEW_RANKINGS_KEY)
    setError('')
    setSaved('')
    setSaving(true)
    queryClient.setQueryData<RankingsRead>(REVIEW_RANKINGS_KEY, { visible: next, failed: false })
    const result = await saveRankingsVisible(next)
    setSaving(false)
    if (!result.ok) {
      queryClient.setQueryData(REVIEW_RANKINGS_KEY, before)
      setError(result.message)
      return
    }
    setSaved(next ? 'The ranking is now shown to everyone.' : 'The ranking is now hidden from everyone.')
    void queryClient.invalidateQueries({ queryKey: REVIEW_RANKINGS_KEY })
  }

  if (!known) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  return (
    <CcSection
      title="Review leaderboard"
      description="The monthly ranking of reward-eligible reviews. One switch, for every employee."
    >
      {failed ? (
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }} role="alert">
          The setting could not be read, so it cannot be changed yet. Until it can be read, employees do not see the ranking.
        </div>
      ) : null}

      <div className={cc.list}>
        <div className={cc.listRow}>
          <div className={cc.listMain}>
            <div>Leaderboard on the Reviews page</div>
            <div className={cc.listDetail}>
              {visible
                ? 'Shown at the bottom of the Reviews page, with a link to past months from BOE Credits.'
                : 'Hidden. Employees see no ranking, no leader, and no link to past months.'}
            </div>
          </div>
          <div className={cc.rowActions}>
            <CcBadge tone={visible ? 'green' : 'gray'}>{visible ? 'Shown' : 'Hidden'}</CcBadge>
            <button
              className={visible ? 'boe-btn boe-btn-ghost' : 'boe-btn boe-btn-primary'}
              disabled={failed || saving}
              onClick={() => void choose(!visible)}
            >
              {saving ? 'Saving…' : visible ? 'Hide the ranking' : 'Show the ranking'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className={cc.error}>{error}</div>}
      {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

      <div className={cc.note} style={{ marginTop: 18 }}>
        <div className={cc.noteTitle}>What this changes</div>
        Only what is shown. Reviews, credits and payslips are counted and paid exactly as before, and everyone
        still sees their own reviews and credits. A change reaches employees within about a minute of their
        next page load.
      </div>
    </CcSection>
  )
}
