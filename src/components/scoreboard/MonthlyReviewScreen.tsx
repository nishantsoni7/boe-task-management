'use client'

// THE MONTHLY REVIEW (owner, 2026-11-12; redesigned as guided steps 2026-11-13), the owner alone. Four steps,
// in the order the work has to happen, one on screen at a time; the step bar shows what is done:
//
//   1. Standings          the month's final standings (the frozen nightly record) as score bars, with the
//                         change on last month, votes and sales
//   2. Awards             each suggested winner confirmed or changed, with an optional line
//   3. Freeze & announce  the WhatsApp message previewed from the picks; "Freeze" saves the awards for good
//                         (they show on everybody's card next month), then the message is ready to copy
//   4. Private reviews    the lowest scorer and anybody in the Red zone get up to 3 goals and a check-in date
//                         (they see their goals on their own card); the step (1:1, written warning, role and
//                         salary review) comes from their Red streak. Never announced.
//
// Every read and write is /api/scoreboard/review, which refuses anybody but the owner.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { istAddDays } from '@/lib/istDate'
import { bandOf, type Band } from '@/lib/scoreboard/score'
import { announcement, type AwardKey } from '@/lib/scoreboard/review'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from './monthlyReview.module.css'

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

type Step = 1 | 2 | 3 | 4

const FILL: Record<Band, string> = { star: styles.fStar, strong: styles.fStrong, steady: styles.fSteady, watch: styles.fWatch, red: styles.fRed }

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10)
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
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
  if (query.error instanceof Error && !d) return <div className={styles.card} role="alert"><p className={styles.warn}>{query.error.message}</p></div>
  if (!d) return <p className={styles.muted}>Loading the month…</p>

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMonth(shiftMonth(d.month, -1))}>‹ Month before</button>
        <h2 className={styles.monthName}>{d.monthLabel}</h2>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMonth(shiftMonth(d.month, 1))}>Month after ›</button>
        <span className={styles.state}>
          {d.frozen ? `Frozen and announced on ${shortDate(d.frozen.frozen_at)}`
            : d.ended ? 'Ended: confirm the awards, then freeze and announce' : 'Still running: the standings will change'}
        </span>
      </div>

      {d.rows.length === 0 ? (
        <div className={styles.card}><p className={styles.muted}>There is no record for {d.monthLabel} yet. The record is written every night at 11:30 pm.</p></div>
      ) : (
        // Keyed so a new month, or the moment it is frozen, starts the steps and the picks afresh.
        <MonthSteps key={`${d.month}-${d.frozen ? 'frozen' : 'open'}`} data={d} />
      )}
    </div>
  )
}

function MonthSteps({ data }: { data: Data }) {
  const frozen = !!data.frozen
  const [step, setStep] = useState<Step>(frozen ? 3 : data.ended ? 2 : 1)
  const [picks, setPicks] = useState<Record<string, string[]>>(() => Object.fromEntries(data.awards.map(a => [a.key, frozen ? a.saved : a.suggested])))
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>(() => Object.fromEntries(data.awards.map(a => [a.key, frozen])))

  const nConfirmed = data.awards.filter(a => confirmed[a.key]).length
  const flagged = data.rows.filter(r => r.flag)
  const nReviewed = flagged.filter(r => data.reviews.some(x => x.employee_id === r.id)).length

  const steps: { n: Step; name: string; sub: string; done: boolean }[] = [
    { n: 1, name: 'Standings', sub: `${data.rows.filter(r => r.score !== null).length} people`, done: step > 1 || frozen },
    { n: 2, name: 'Awards', sub: frozen ? 'Saved' : !data.ended ? 'After the month ends' : `${nConfirmed} of ${data.awards.length} confirmed`, done: frozen || (data.ended && nConfirmed === data.awards.length) },
    { n: 3, name: 'Freeze & announce', sub: frozen ? 'Announced' : 'After the awards', done: frozen },
    { n: 4, name: 'Private reviews', sub: flagged.length === 0 ? 'Nobody this month' : `${nReviewed} of ${flagged.length} written`, done: flagged.length > 0 && nReviewed === flagged.length },
  ]

  return (
    <>
      <ol className={styles.steps} aria-label="Review steps">
        {steps.map(s => (
          <li key={s.n}>
            <button type="button" className={styles.step} aria-current={step === s.n ? 'step' : undefined} onClick={() => setStep(s.n)}>
              <span className={`${styles.dot} ${step === s.n ? styles.dotNow : s.done ? styles.dotDone : ''}`} aria-hidden="true">
                {s.done && step !== s.n ? <Check size={14} /> : s.n}
              </span>
              <span>
                <span className={styles.stepName}>{s.name}</span>
                <span className={styles.stepSub}>{s.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {step === 1 && <Standings rows={data.rows} onNext={() => setStep(2)} />}
      {step === 2 && (
        <Awards data={data} picks={picks} setPicks={setPicks} notes={notes} setNotes={setNotes}
          confirmed={confirmed} setConfirmed={setConfirmed} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      )}
      {step === 3 && (
        <Freeze data={data} picks={picks} notes={notes} allConfirmed={nConfirmed === data.awards.length}
          onBack={() => setStep(2)} onNext={() => setStep(4)} />
      )}
      {step === 4 && <Reviews data={data} flagged={flagged} onBack={() => setStep(3)} />}
    </>
  )
}

function Standings({ rows, onNext }: { rows: Row[]; onNext: () => void }) {
  // Rows come best first; people without a score sit at the end and get no rank.
  const rankOf = new Map(rows.filter(r => r.score !== null).map((r, i) => [r.id, i + 1]))
  return (
    <section className={styles.section} aria-labelledby="standings-heading">
      <div className={styles.sectionHead}>
        <h3 id="standings-heading" className={styles.h2}>Step 1 · Final standings</h3>
        <p className={styles.muted}>Only you see the full list. The change is on last month’s final score.</p>
      </div>
      <div className={styles.card}>
        {rows.map(r => {
          const band = r.score === null ? null : bandOf(r.score)
          return (
            <div key={r.id} className={styles.standRow}>
              <span className={styles.rank}>{rankOf.get(r.id) ?? '–'}</span>
              <span className={styles.who}>
                {r.name}
                <span className={styles.whoSub}>
                  {[r.band, r.track === 'sales' ? 'sales' : null, `${r.votes} ${r.votes === 1 ? 'vote' : 'votes'}`,
                    r.sales ? `₹${Math.round(r.sales).toLocaleString('en-IN')}` : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className={styles.track} aria-hidden="true">
                {band && <span className={`${styles.fill} ${FILL[band]}`} style={{ width: `${Math.max(2, Math.min(100, r.score ?? 0))}%` }} />}
              </span>
              <span className={styles.score}>{r.score ?? '–'}</span>
              <span className={r.change === null ? styles.muted : r.change >= 0 ? styles.up : styles.down}>
                {r.change === null ? '—' : r.change >= 0 ? `▲ ${r.change}` : `▼ ${Math.abs(r.change)}`}
              </span>
            </div>
          )
        })}
        <div className={styles.legend} aria-label="Bands">
          <span><i className={`${styles.swatch} ${styles.fStar}`} />Star 85+</span>
          <span><i className={`${styles.swatch} ${styles.fStrong}`} />Strong 70+</span>
          <span><i className={`${styles.swatch} ${styles.fSteady}`} />Steady 55+</span>
          <span><i className={`${styles.swatch} ${styles.fWatch}`} />Watch 40+</span>
          <span><i className={`${styles.swatch} ${styles.fRed}`} />Red zone below 40</span>
        </div>
      </div>
      <div className={styles.nav}>
        <button type="button" className="boe-btn boe-btn-primary" onClick={onNext}>Next: awards ›</button>
      </div>
    </section>
  )
}

type Setter<T> = (fn: (prev: T) => T) => void

function Awards({ data, picks, setPicks, notes, setNotes, confirmed, setConfirmed, onBack, onNext }: {
  data: Data
  picks: Record<string, string[]>; setPicks: Setter<Record<string, string[]>>
  notes: Record<string, string>; setNotes: Setter<Record<string, string>>
  confirmed: Record<string, boolean>; setConfirmed: Setter<Record<string, boolean>>
  onBack: () => void; onNext: () => void
}) {
  const frozen = !!data.frozen
  const scored = data.rows.filter(r => r.score !== null)
  const name = (id: string) => data.rows.find(r => r.id === id)?.name ?? 'Unknown'
  const change = (key: string, ids: string[]) => {
    setPicks(p => ({ ...p, [key]: ids }))
    setConfirmed(c => ({ ...c, [key]: false }))
  }

  return (
    <section className={styles.section} aria-labelledby="awards-heading">
      <div className={styles.sectionHead}>
        <h3 id="awards-heading" className={styles.h2}>Step 2 · {frozen ? 'The awards' : 'Confirm the awards'}</h3>
        <p className={styles.muted}>{frozen ? 'Saved when the month was frozen.' : 'Suggested from the final scores. Change any pick, add a line of praise, then confirm.'}</p>
      </div>
      {!frozen && !data.ended && <div className={styles.card}><p className={styles.muted}>The awards can be confirmed once the month has ended.</p></div>}
      <div className={styles.awards}>
        {data.awards.map(a => {
          const ids = picks[a.key] ?? []
          const isConfirmed = !!confirmed[a.key]
          return (
            <div key={a.key} className={`${styles.award} ${isConfirmed ? styles.awardDone : ''}`}>
              <div className={styles.awardHead}>
                <h4 className={styles.awardName}>{a.label}</h4>
                <span className={`${styles.chip} ${frozen ? styles.chipGreen : isConfirmed ? styles.chipGreen : styles.chipAmber}`}>
                  {frozen ? 'Saved' : isConfirmed ? 'Confirmed' : 'Suggested'}
                </span>
              </div>
              <div className={styles.winner}>{ids.length ? ids.map(name).join(', ') : 'Nobody this month'}</div>
              <p className={styles.muted}>{a.rule}</p>
              {!frozen && data.ended && (
                <>
                  {a.many ? (
                    <fieldset className={styles.checks} style={{ border: 'none', padding: 0, margin: 0 }}>
                      <legend className={styles.field}>Winners</legend>
                      {scored.map(r => (
                        <label key={r.id} className={styles.check}>
                          <input type="checkbox" checked={ids.includes(r.id)}
                            onChange={e => change(a.key, e.target.checked ? [...ids, r.id] : ids.filter(x => x !== r.id))} />
                          {r.name}
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <label className={styles.field}>
                      Winner
                      <select className={styles.input} value={ids[0] ?? ''} onChange={e => change(a.key, e.target.value ? [e.target.value] : [])}>
                        <option value="">Nobody this month</option>
                        {scored.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label className={styles.field}>
                    Line for the announcement (optional)
                    <input className={styles.input} value={notes[a.key] ?? ''} maxLength={200}
                      onChange={e => setNotes(n => ({ ...n, [a.key]: e.target.value }))} />
                  </label>
                  <div className={styles.awardActions}>
                    {isConfirmed
                      ? <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setConfirmed(c => ({ ...c, [a.key]: false }))}>Undo confirm</button>
                      : <button type="button" className="boe-btn boe-btn-primary" onClick={() => setConfirmed(c => ({ ...c, [a.key]: true }))}>Confirm</button>}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className={styles.nav}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onBack}>‹ Standings</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={onNext}>Next: freeze &amp; announce ›</button>
      </div>
    </section>
  )
}

function Freeze({ data, picks, notes, allConfirmed, onBack, onNext }: {
  data: Data; picks: Record<string, string[]>; notes: Record<string, string>; allConfirmed: boolean
  onBack: () => void; onNext: () => void
}) {
  const queryClient = useQueryClient()
  const frozen = !!data.frozen
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const name = (id: string) => data.rows.find(r => r.id === id)?.name ?? 'Unknown'
  const message = frozen && data.announcement ? data.announcement : announcement(data.monthLabel,
    data.awards.map(a => ({ award: a.key as AwardKey, names: (picks[a.key] ?? []).map(name), note: notes[a.key]?.trim() || null })))
  const waiting = data.awards.filter(a => !picks[a.key]?.length)

  const freeze = async () => {
    if (!sure) { setSure(true); return }
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/review', { body: { action: 'freeze', month: data.month, awards: picks, notes } })
    setBusy(false)
    if (!r.ok) { setError(r.error); setSure(false); return }
    await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(message); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <section className={styles.section} aria-labelledby="freeze-heading">
      <div className={styles.sectionHead}>
        <h3 id="freeze-heading" className={styles.h2}>Step 3 · {frozen ? 'Announced' : 'Freeze & announce'}</h3>
        <p className={styles.muted}>Winners only. A low score is never announced.</p>
      </div>
      <div className={styles.freeze}>
        <div className={styles.card} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className={styles.stepName}>WhatsApp message{frozen ? '' : ' (preview)'}</span>
          <pre className={styles.message}>{message}</pre>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={copy} disabled={!frozen}>
            {!frozen ? 'Copy after freezing' : copied ? 'Copied' : 'Copy message'}
          </button>
        </div>
        <div className={styles.card} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {frozen ? (
            <>
              <p className={styles.ok}>Frozen on {shortDate(data.frozen!.frozen_at)}. Everybody’s card shows the champions this month.</p>
              <p className={styles.muted}>The Star Seller can now pick one of their own orders for Factory Focus.</p>
            </>
          ) : !data.ended ? (
            <p className={styles.muted}>Freezing opens once {data.monthLabel} has ended.</p>
          ) : (
            <>
              <span className={styles.stepName}>Before you freeze</span>
              <ul className={styles.list}>
                <li>{allConfirmed ? 'All awards confirmed' : 'Some awards are still only suggested (step 2)'}</li>
                {waiting.length > 0 && <li>No winner for: {waiting.map(a => a.label).join(', ')}</li>}
                <li>Freezing saves the awards for good; they cannot be changed afterwards.</li>
              </ul>
              {sure && <p className={styles.warn} role="alert">Press again to freeze {data.monthLabel} for good.</p>}
              {error && <p className={styles.warn} role="alert">{error}</p>}
              <button type="button" className={`boe-btn boe-btn-primary ${styles.wide}`} onClick={freeze} disabled={busy || !allConfirmed} aria-busy={busy}>
                {busy ? 'Freezing…' : sure ? `Yes, freeze ${data.monthLabel} and announce` : `Freeze ${data.monthLabel} and announce`}
              </button>
              {!allConfirmed && <p className={styles.muted}>Confirm every award in step 2 first.</p>}
            </>
          )}
        </div>
      </div>
      <div className={styles.nav}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onBack}>‹ Awards</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={onNext}>Next: private reviews ›</button>
      </div>
    </section>
  )
}

function Reviews({ data, flagged, onBack }: { data: Data; flagged: Row[]; onBack: () => void }) {
  return (
    <section className={styles.section} aria-labelledby="reviews-heading">
      <div className={styles.sectionHead}>
        <h3 id="reviews-heading" className={styles.h2}>Step 4 · Private reviews</h3>
        <p className={styles.muted}>Never announced. Each person sees only their own goals, on their own card.</p>
      </div>
      {flagged.length === 0
        ? <div className={styles.card}><p className={styles.muted}>Nobody is in the Red zone this month.</p></div>
        : (
          <div className={styles.reviews}>
            {flagged.map(r => <ReviewCard key={`${data.month}-${r.id}`} month={data.month} row={r} saved={data.reviews.find(x => x.employee_id === r.id) ?? null} />)}
          </div>
        )}
      <div className={styles.nav}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onBack}>‹ Freeze &amp; announce</button>
      </div>
    </section>
  )
}

function ReviewCard({ month, row, saved }: { month: string; row: Row; saved: Review | null }) {
  const queryClient = useQueryClient()
  const nextMonth = shiftMonth(month, 1)
  const [goals, setGoals] = useState<string[]>(saved?.goals.length ? [...saved.goals, '', ''].slice(0, 3) : ['', '', ''])
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
    <div className={styles.review}>
      <div className={styles.awardHead}>
        <h4 className={styles.awardName}>{row.name} · {row.score}</h4>
        <span className={`${styles.chip} ${row.flag?.reason === 'red' ? styles.chipRed : styles.chipAmber}`}>{row.flag?.reason === 'red' ? 'Red zone' : 'Lowest score'}</span>
      </div>
      <p className={styles.muted}><strong>Step: {row.flag?.label}</strong>{saved ? ' · saved' : ''}</p>
      {goals.map((g, i) => (
        <label key={i} className={styles.field}>
          Goal {i + 1}{i > 0 ? ' (optional)' : ''}
          <input className={styles.input} value={g} maxLength={200}
            onChange={e => setGoals(gs => gs.map((x, j) => j === i ? e.target.value : x))} />
        </label>
      ))}
      <label className={styles.field}>
        Check-in on
        <input className={styles.input} type="date" value={checkin} min={nextMonth} onChange={e => setCheckin(e.target.value)} />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={warning} onChange={e => setWarning(e.target.checked)} />
        Written warning given
      </label>
      <label className={styles.field}>
        Private note (only you see it)
        <input className={styles.input} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} />
      </label>
      <div className={styles.awardActions}>
        <button type="button" className="boe-btn boe-btn-primary" onClick={save} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Save review'}</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.warn} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </div>
  )
}
