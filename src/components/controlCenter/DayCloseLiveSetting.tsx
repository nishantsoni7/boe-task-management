'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CcBadge, CcSection, cc } from './CcPrimitives'
import { dayCloseFetch, dayLabel } from '@/components/dayClose/api'
import { istToday } from '@/lib/istDate'

// Control Center › Day Close & Scoreboard (20270704000000): one switch for the team, starting PAUSED.
//
// Paused, the team sees none of it (the red "plan was due" strip and banner, the Scoreboard card, the evening
// score line, the vote and Star Seller cards) and none of the rules run (nightly strikes, the nightly score
// record, the proof rule, the leave lock). Switched on, they all start together, counting from that day.
//
// The read and the write are the Day Close members route, which is for an administrator or the reviewer; the
// write (action set_live) is an administrator's alone. This screen only draws the switch as it is SAVED.

type Read = { live: boolean; liveSince: string | null }
const KEY = ['day-close', 'live'] as const

export function DayCloseLiveSetting() {
  const queryClient = useQueryClient()
  const query = useQuery<Read>({
    queryKey: KEY,
    queryFn: async () => {
      const r = await dayCloseFetch<{ live?: boolean; live_since?: string | null }>('/api/day-close/members')
      if (!r.ok) throw new Error(r.error)
      return { live: r.data.live === true, liveSince: r.data.live_since ?? null }
    },
    staleTime: 15_000,
    retry: false,
  })
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const choose = async (live: boolean) => {
    setError('')
    setSaved('')
    setSaving(true)
    const r = await dayCloseFetch('/api/day-close/members', { body: { action: 'set_live', live } })
    setSaving(false)
    setConfirming(false)
    if (!r.ok) { setError(r.error); return }
    setSaved(live ? 'Day Close and the Scoreboard are now live for the team.' : 'Day Close and the Scoreboard are now paused for the team.')
    await queryClient.invalidateQueries({ queryKey: KEY })
  }

  if (query.isPending) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  if (query.isError || !query.data) {
    return (
      <CcSection title="Day Close & Scoreboard">
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }} role="alert">
          {query.error instanceof Error ? query.error.message : 'The setting could not be read.'} Until it can be read, nothing can be changed here.
        </div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void query.refetch()}>Retry</button>
      </CcSection>
    )
  }

  const { live, liveSince } = query.data

  return (
    <CcSection
      title="Day Close & Scoreboard"
      description="One switch for the whole team. It starts paused, so nobody is shown, struck or scored for something they have not been introduced to."
    >
      <div className={cc.list}>
        <div className={cc.listRow}>
          <div className={cc.listMain}>
            <div>Day Close and the Scoreboard for the team</div>
            <div className={cc.listDetail}>
              {live
                ? `Live${liveSince ? ` since ${dayLabel(istToday(new Date(liveSince)))}` : ''}. The team sees the cards and messages, and the rules run.`
                : 'Paused. The team sees none of it and none of the rules run.'}
            </div>
          </div>
          <div className={cc.rowActions}>
            <CcBadge tone={live ? 'green' : 'gray'}>{live ? 'Live' : 'Paused'}</CcBadge>
            {live ? (
              <button className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => void choose(false)}>
                {saving ? 'Saving…' : 'Pause for the team'}
              </button>
            ) : confirming ? (
              <>
                <button className="boe-btn boe-btn-primary" disabled={saving} onClick={() => void choose(true)}>
                  {saving ? 'Saving…' : 'Yes, switch on'}
                </button>
                <button className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
              </>
            ) : (
              <button className="boe-btn boe-btn-primary" disabled={saving} onClick={() => setConfirming(true)}>
                Switch on for the team
              </button>
            )}
          </div>
        </div>
      </div>

      {confirming && (
        <div className={cc.note} style={{ marginTop: 12 }}>
          <div className={cc.noteTitle}>Before you switch on</div>
          From now on a missing or late plan and an unclosed day are recorded as strikes each night at 11:15 pm, scores are
          recorded at 11:30 pm, a member must post proof before finishing a task, and leave sent with work pending is locked.
          Counting starts today. Make sure the team has been told.
        </div>
      )}

      {error && <div className={cc.error}>{error}</div>}
      {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

      <div className={cc.note} style={{ marginTop: 18 }}>
        <div className={cc.noteTitle}>What pausing hides from the team</div>
        The red &ldquo;Your plan was due&rdquo; and &ldquo;Close your day&rdquo; messages (on Modules and on the Today card), the
        Scoreboard card on Modules and the Task Management dashboard, the evening score line, the vote card and the Star
        Seller card.
      </div>
      <div className={cc.note} style={{ marginTop: 12 }}>
        <div className={cc.noteTitle}>What pausing stops</div>
        The nightly strikes, the nightly score record, the proof rule on finishing a task, and the lock on leave sent with
        work pending. Days while paused are neither credit nor blame: counting starts from the day you switch on.
      </div>
      <div className={cc.note} style={{ marginTop: 12 }}>
        <div className={cc.noteTitle}>What it does not touch</div>
        Strikes already recorded, who takes part, and your own screens: Team Today and the Monthly Review.
      </div>
    </CcSection>
  )
}
