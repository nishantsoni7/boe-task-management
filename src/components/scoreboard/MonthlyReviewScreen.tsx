'use client'

// THE MONTHLY REVIEW (owner, 2026-11-12), the owner alone:
//
//   1. the month's final standings (from the frozen nightly record), with the change on last month
//   2. the suggested awards, each confirmed or changed by the owner, with an optional line
//   3. "Freeze & announce": the awards are saved for good and shown on everybody's card next month; the
//      WhatsApp message is ready to copy
//   4. private reviews: the lowest scorer and anybody in the Red zone get up to 3 written goals and a check-in
//      date (they see their goals on their own card); the step (1:1, written warning, role and salary review)
//      comes from their Red streak
//
// Every read and write is /api/scoreboard/review, which refuses anybody but the owner.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { istAddDays } from '@/lib/istDate'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from '@/components/dayClose/dayClose.module.css'

type Row = {
  id: string
  name: string
  track: 'general' | 'sales'
  score: number | null
  band: string | null
  change: number | null
  votes: number
  sales: number
  flag: { reason: 'lowest' | 'red'; redStreak: number; step: string; label: string } | null
}
type Award = { key: string; label: string; rule: string; many: boolean; suggested: string[]; saved: string[] }
type Review = { employee_id: string; goals: string[]; checkin_on: string; warning: boolean; note: string | null }
type Data = {
  month: string
  monthLabel: string
  ended: boolean
  frozen: { frozen_at: string } | null
  rows: Row[]
  awards: Award[]
  reviews: Review[]
  announcement: string | null
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10)
}

export function MonthlyReviewScreen() {
  const [month, setMonth] = useState<string | null>(null)
  const query = useQuery<Data>({
    queryKey: ['scoreboard', 'review', month],
    queryFn: async () => {
      const r = await dayCloseFetch<Data>(`/api/scoreboard/review${month ? `?month=${month}` : ''}`)
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    placeholderData: p => p,
    retry: false,
  })
  const d = query.data
  if (query.error instanceof Error && !d) return <div className={`${styles.banner} ${styles.bannerRed}`} role="alert">{query.error.message}</div>
  if (!d) return <p className={styles.muted}>Loading the month…</p>

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMonth(shiftMonth(d.month, -1))}>‹ Month before</button>
        <strong>{d.monthLabel}</strong>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMonth(shiftMonth(d.month, 1))}>Month after ›</button>
        <span className={styles.muted}>
          {d.frozen ? `Frozen and announced on ${new Date(d.frozen.frozen_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
            : d.ended ? 'Ended: confirm the awards, then freeze and announce' : 'Still running: the standings will change'}
        </span>
      </div>

      {d.rows.length === 0 ? (
        <div className={styles.card}><p className={styles.muted}>There is no record for {d.monthLabel} yet. The record is written every night at 11:30 pm.</p></div>
      ) : (
        <>
          <Standings rows={d.rows} />
          <Awards key={`${d.month}-${d.frozen ? 'frozen' : 'open'}`} data={d} />
          <Reviews data={d} />
        </>
      )}
    </div>
  )
}

function Standings({ rows }: { rows: Row[] }) {
  return (
    <section className={styles.card} aria-labelledby="standings-heading">
      <h2 id="standings-heading" className={styles.eyebrow}>Final standings (only you see the full list)</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 520 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#686D6C', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <th style={{ padding: '6px 8px' }}>#</th><th style={{ padding: '6px 8px' }}>Person</th><th style={{ padding: '6px 8px' }}>Score</th>
              <th style={{ padding: '6px 8px' }}>Band</th><th style={{ padding: '6px 8px' }}>vs last month</th><th style={{ padding: '6px 8px' }}>Votes</th>
              <th style={{ padding: '6px 8px' }}>Sales</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} style={{ borderTop: '1px solid #F1EEE9' }}>
                <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{r.score === null ? '–' : i + 1}</td>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.name}{r.track === 'sales' ? <span className={styles.muted}> · sales</span> : null}</td>
                <td style={{ padding: '6px 8px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.score ?? '–'}</td>
                <td style={{ padding: '6px 8px' }}>{r.band ?? '–'}</td>
                <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums', color: r.change === null ? '#686D6C' : r.change >= 0 ? '#276247' : '#B42332' }}>
                  {r.change === null ? '–' : r.change >= 0 ? `▲ ${r.change}` : `▼ ${Math.abs(r.change)}`}
                </td>
                <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{r.votes}</td>
                <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{r.sales ? `₹${Math.round(r.sales).toLocaleString('en-IN')}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Awards({ data }: { data: Data }) {
  const queryClient = useQueryClient()
  const frozen = !!data.frozen
  // Starts from the suggestions (or what was saved). The parent keys this by month, so it starts afresh.
  const [picks, setPicks] = useState<Record<string, string[]>>(() => Object.fromEntries(data.awards.map(a => [a.key, frozen ? a.saved : a.suggested])))
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const scored = data.rows.filter(r => r.score !== null)
  const name = (id: string) => data.rows.find(r => r.id === id)?.name ?? 'Unknown'

  const freeze = async () => {
    if (!confirm) { setConfirm(true); return }
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/review', { body: { action: 'freeze', month: data.month, awards: picks, notes } })
    setBusy(false)
    if (!r.ok) { setError(r.error); setConfirm(false); return }
    await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }

  const copy = async () => {
    if (!data.announcement) return
    try { await navigator.clipboard.writeText(data.announcement); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <section className={styles.card} aria-labelledby="awards-heading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="awards-heading" className={styles.eyebrow}>Awards</h2>
      {data.awards.map(a => (
        <div key={a.key} className={styles.item}>
          <div className={styles.itemHead}>
            <div>
              <p className={styles.itemTitle}>{a.label}</p>
              <p className={styles.itemSub}>{a.rule}{!frozen && a.suggested.length ? ` · suggested: ${a.suggested.map(name).join(', ')}` : ''}</p>
            </div>
          </div>
          {frozen ? (
            <p className={styles.itemSub}><strong>{a.saved.length ? a.saved.map(name).join(', ') : 'Nobody'}</strong></p>
          ) : a.many ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              {scored.map(r => (
                <label key={r.id} className={styles.label} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}>
                  <input type="checkbox" checked={(picks[a.key] ?? []).includes(r.id)}
                    onChange={e => setPicks(p => ({ ...p, [a.key]: e.target.checked ? [...(p[a.key] ?? []), r.id] : (p[a.key] ?? []).filter(x => x !== r.id) }))} />
                  {r.name}
                </label>
              ))}
            </div>
          ) : (
            <select className={styles.input} value={(picks[a.key] ?? [])[0] ?? ''} aria-label={`Winner of ${a.label}`}
              onChange={e => setPicks(p => ({ ...p, [a.key]: e.target.value ? [e.target.value] : [] }))}>
              <option value="">Nobody this month</option>
              {scored.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          {!frozen && (
            <input className={styles.input} value={notes[a.key] ?? ''} maxLength={200} onChange={e => setNotes(n => ({ ...n, [a.key]: e.target.value }))}
              placeholder="One line for the announcement (optional)" aria-label={`Line for ${a.label}`} />
          )}
        </div>
      ))}

      {!frozen && data.ended && (
        <>
          {confirm && <p className={styles.error} role="alert">Freezing saves these awards for good and shows them on everybody’s card. Press again to confirm.</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button type="button" className={`boe-btn boe-btn-primary ${styles.wide}`} onClick={freeze} disabled={busy} aria-busy={busy}>
            {busy ? 'Freezing…' : confirm ? `Yes, freeze ${data.monthLabel} and announce` : `Freeze ${data.monthLabel} and announce`}
          </button>
        </>
      )}
      {!frozen && !data.ended && <p className={styles.muted}>The awards can be confirmed once the month has ended.</p>}

      {frozen && data.announcement && (
        <div className={styles.form}>
          <label className={styles.label} htmlFor="announcement">WhatsApp message (winners only)</label>
          <textarea id="announcement" className={styles.input} rows={8} readOnly value={data.announcement} onFocus={e => e.currentTarget.select()} />
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
          </div>
        </div>
      )}
    </section>
  )
}

function Reviews({ data }: { data: Data }) {
  const flagged = data.rows.filter(r => r.flag)
  return (
    <section className={styles.card} aria-labelledby="reviews-heading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="reviews-heading" className={styles.eyebrow}>Private reviews (never announced)</h2>
      {flagged.length === 0
        ? <p className={styles.muted}>Nobody is in the Red zone this month.</p>
        : flagged.map(r => <ReviewRow key={`${data.month}-${r.id}`} month={data.month} row={r} saved={data.reviews.find(x => x.employee_id === r.id) ?? null} />)}
    </section>
  )
}

function ReviewRow({ month, row, saved }: { month: string; row: Row; saved: Review | null }) {
  const queryClient = useQueryClient()
  const nextMonth = shiftMonth(month, 1)
  const [goals, setGoals] = useState<string[]>(saved?.goals ?? ['', '', ''])
  const [checkin, setCheckin] = useState(saved?.checkin_on ?? istAddDays(nextMonth, 14))
  const [warning, setWarning] = useState(saved?.warning ?? row.flag?.step !== 'one_to_one')
  const [note, setNote] = useState(saved?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async () => {
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/review', {
      body: { action: 'goals', month, employee_id: row.id, goals: goals.filter(g => g.trim()), checkin_on: checkin, warning, note },
    })
    setBusy(false)
    setMsg(r.ok ? { ok: true, text: 'Saved. They will see their goals on their card.' } : { ok: false, text: r.error })
    if (r.ok) await queryClient.invalidateQueries({ queryKey: ['scoreboard', 'review'] })
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <p className={styles.itemTitle}>{row.name} · {row.score}</p>
        <span className={`${styles.chip} ${row.flag?.reason === 'red' ? styles.chipRed : styles.chipAmber}`}>{row.flag?.reason === 'red' ? 'Red zone' : 'Lowest score'}</span>
      </div>
      <p className={styles.itemSub}><strong>{row.flag?.label}</strong></p>
      {goals.map((g, i) => (
        <input key={i} className={styles.input} value={g} maxLength={200} placeholder={`Goal ${i + 1} for next month`}
          aria-label={`Goal ${i + 1} for ${row.name}`} onChange={e => setGoals(gs => gs.map((x, j) => j === i ? e.target.value : x))} />
      ))}
      <label className={styles.label}>
        Check-in on
        <input className={styles.input} type="date" value={checkin} min={nextMonth} onChange={e => setCheckin(e.target.value)} />
      </label>
      <label className={styles.label} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={warning} onChange={e => setWarning(e.target.checked)} />
        Written warning given
      </label>
      <input className={styles.input} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} placeholder="Private note (only you see it)" aria-label={`Private note about ${row.name}`} />
      <div className={styles.actions}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={save} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Save review'}</button>
      </div>
      {msg && <p className={msg.ok ? styles.muted : styles.error} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </div>
  )
}
