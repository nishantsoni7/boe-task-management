'use client'

// MY DAY (owner, 2026-11-12): the person's own day, top to bottom in the order they live it.
//
//   1. what to do now           file the plan by 10:30 / close the day before punching out / closed
//   2. the plan                 tasks somebody gave you that are due (cannot be removed), then your own
//                               items, each with the output you expect; "File my plan"
//   3. through the day          each item: Done (a link or a photo; an assigned task is done once it is
//                               submitted in Task Management) or Not done (a reason and a new date)
//   4. close the day            when nothing is open, before the punch-out on the machine
//
// Every read and write is /api/day-close/me, which takes the person from the bearer token. The server
// decides the times and the rules (src/lib/dayClose/rules.ts); this page only draws them.

import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import { CircleCheck, Lock, TriangleAlert, Clock } from 'lucide-react'
import { shrinkPhoto } from '@/lib/vendors/photos'
import { istAddDays } from '@/lib/istDate'
import { clock } from '@/lib/dayClose/rules'
import { dayCloseFetch, dayLabel, istClock } from './api'
import styles from './dayClose.module.css'

type Item = {
  id: string
  source: 'assigned' | 'own'
  task_id: string | null
  title: string
  expected_output: string | null
  status: 'open' | 'done' | 'not_done'
  effective: 'open' | 'done' | 'not_done'
  proof_url: string | null
  proof_note: string | null
  photo_url: string | null
  reason: string | null
  next_date: string | null
  task_status?: string | null
}

type Prompt =
  | { kind: 'none' }
  | { kind: 'file_plan'; late: boolean; due: string }
  | { kind: 'close_day'; open: number }
  | { kind: 'closed' }

type MyDay = {
  member: boolean
  today: string
  workingDay?: boolean
  planDue: number
  closeOpens: number
  plan?: { submitted_at: string | null; closed_at: string | null; close_note: string | null } | null
  items?: Item[]
  counts?: { total: number; done: number; notDone: number; open: number }
  prompt?: Prompt
  punch?: { checkInAt: string | null; checkOutAt: string | null }
  reviewerName?: string | null
}

export function MyDayScreen() {
  const query = useQuery<MyDay>({
    queryKey: ['day-close', 'me'],
    queryFn: async () => {
      const r = await dayCloseFetch<MyDay>('/api/day-close/me')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    retry: false,
  })
  const day = query.data ?? null
  const loadError = query.error instanceof Error ? query.error.message : null
  const { refetch } = query
  const load = useCallback(async () => { await refetch() }, [refetch])

  if (loadError && !day) {
    return <div className={`${styles.banner} ${styles.bannerRed}`} role="alert">{loadError}</div>
  }
  if (!day) return <p className={styles.muted}>Loading your day…</p>

  if (!day.member) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h2 className={styles.title}>Day Close is not switched on for you</h2>
          <p className={styles.muted}>When it is, you will plan your day here each morning and close it here before you leave.</p>
        </div>
      </div>
    )
  }

  if (!day.workingDay) {
    return (
      <div className={styles.page}>
        <div className={`${styles.banner} ${styles.bannerBlue}`}>
          <div>
            <p className={styles.bannerTitle}>No plan needed today</p>
            <p className={styles.bannerText}>{dayLabel(day.today)} is a Sunday, a holiday or a day of approved leave.</p>
          </div>
        </div>
      </div>
    )
  }

  const plan = day.plan ?? null
  const items = day.items ?? []
  const assigned = items.filter(i => i.source === 'assigned')
  const own = items.filter(i => i.source === 'own')
  const filed = !!plan?.submitted_at
  const closed = !!plan?.closed_at

  return (
    <div className={styles.page}>
      <PromptBanner day={day} />

      <div className={styles.facts}>
        <span>{dayLabel(day.today)}</span>
        <span>Punch in <strong>{istClock(day.punch?.checkInAt)}</strong></span>
        {day.punch?.checkOutAt && <span>Last punch <strong>{istClock(day.punch.checkOutAt)}</strong></span>}
        {filed && <span>Plan filed <strong>{istClock(plan?.submitted_at)}</strong></span>}
        {day.counts && day.counts.total > 0 && (
          <span><strong>{day.counts.done}</strong> done · <strong>{day.counts.notDone}</strong> not done · <strong>{day.counts.open}</strong> open</span>
        )}
      </div>

      {loadError && <p className={styles.error} role="alert">{loadError}</p>}

      <section className={styles.card} aria-labelledby="assigned-heading">
        <h2 id="assigned-heading" className={styles.eyebrow}>Given to you, due</h2>
        {assigned.length === 0
          ? <p className={styles.muted}>No task from anybody else is due today.</p>
          : (
            <ul className={styles.items}>
              {assigned.map(i => <ItemRow key={i.id} item={i} filed={filed} closed={closed} today={day.today} onChanged={load} />)}
            </ul>
          )}
      </section>

      <section className={styles.card} aria-labelledby="own-heading">
        <h2 id="own-heading" className={styles.eyebrow}>Your plan for today</h2>
        {own.length === 0 && <p className={styles.muted}>Write what you will get done today, and the output you expect (a post, a call list, a quotation sent).</p>}
        {own.length > 0 && (
          <ul className={styles.items}>
            {own.map(i => <ItemRow key={i.id} item={i} filed={filed} closed={closed} today={day.today} onChanged={load} />)}
          </ul>
        )}
        {!closed && <AddItem onAdded={load} />}
      </section>

      {!filed && <FilePlan count={items.length} onFiled={load} />}
      {filed && !closed && <CloseDay day={day} onClosed={load} />}
      {closed && (
        <div className={`${styles.banner} ${styles.bannerGreen}`}>
          <CircleCheck size={20} aria-hidden="true" />
          <div>
            <p className={styles.bannerTitle}>Day closed at {istClock(plan?.closed_at)}</p>
            {plan?.close_note && <p className={styles.bannerText}>{plan.close_note}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function PromptBanner({ day }: { day: MyDay }) {
  const p = day.prompt
  if (!p || p.kind === 'none') {
    if (day.plan?.submitted_at && !day.plan.closed_at) {
      return (
        <div className={`${styles.banner} ${styles.bannerBlue}`}>
          <Clock size={20} aria-hidden="true" />
          <div>
            <p className={styles.bannerTitle}>Plan filed. Close each item as you finish it.</p>
            <p className={styles.bannerText}>Closing the day opens at {clock(day.closeOpens)}. Close it before you punch out.</p>
          </div>
        </div>
      )
    }
    return null
  }
  if (p.kind === 'file_plan') {
    return (
      <div className={`${styles.banner} ${p.late ? styles.bannerRed : styles.bannerAmber}`} role="status">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <p className={styles.bannerTitle}>{p.late ? `Your plan was due at ${p.due}` : `File your plan by ${p.due}`}</p>
          <p className={styles.bannerText}>A plan filed late, or not at all, is recorded as a strike.</p>
        </div>
      </div>
    )
  }
  if (p.kind === 'close_day') {
    return (
      <div className={`${styles.banner} ${styles.bannerRed}`} role="status">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <p className={styles.bannerTitle}>Close your day before you punch out</p>
          <p className={styles.bannerText}>
            {p.open > 0 ? `${p.open} ${p.open === 1 ? 'item is' : 'items are'} still open. ` : ''}
            Leaving without closing it is recorded as a strike.
          </p>
        </div>
      </div>
    )
  }
  return null
}

function AddItem({ onAdded }: { onAdded: () => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/me', { body: { action: 'add_item', title, expected_output: output } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setTitle(''); setOutput(''); setError(null)
    await onAdded()
  }

  return (
    <form className={styles.form} onSubmit={add} aria-label="Add an item to your plan">
      <label className={styles.label} htmlFor="day-item-title">What will you do?</label>
      <input id="day-item-title" className={styles.input} value={title} maxLength={300}
        onChange={e => setTitle(e.target.value)} placeholder="e.g. Post 1 reel on the new sofa range" />
      <label className={styles.label} htmlFor="day-item-output">Output you expect (optional)</label>
      <input id="day-item-output" className={styles.input} value={output} maxLength={500}
        onChange={e => setOutput(e.target.value)} placeholder="e.g. Reel live on Instagram" />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="submit" className="boe-btn boe-btn-ghost" disabled={busy || title.trim().length < 2} aria-busy={busy}>
          {busy ? 'Adding…' : 'Add item'}
        </button>
      </div>
    </form>
  )
}

function FilePlan({ count, onFiled }: { count: number; onFiled: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const file = async () => {
    if (busy) return
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/me', { body: { action: 'file_plan' } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await onFiled()
  }
  return (
    <div className={styles.card}>
      <p className={styles.muted}>Once filed, your items cannot be removed: each must be closed as Done or Not done before you leave.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={`boe-btn boe-btn-primary ${styles.wide}`} onClick={file} disabled={busy || count === 0} aria-busy={busy}>
          {busy ? 'Filing…' : `File my plan (${count} ${count === 1 ? 'item' : 'items'})`}
        </button>
      </div>
    </div>
  )
}

function CloseDay({ day, onClosed }: { day: MyDay; onClosed: () => Promise<void> }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = day.counts?.open ?? 0
  const early = day.prompt?.kind !== 'close_day'

  const close = async () => {
    if (busy) return
    if (early && !window.confirm(`It is before ${clock(day.closeOpens)}. Close your day now? Use this only if you are leaving early with permission.`)) return
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/me', { body: { action: 'close_day', note } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await onClosed()
  }

  return (
    <section className={styles.card} aria-labelledby="close-heading">
      <h2 id="close-heading" className={styles.eyebrow}>Close your day</h2>
      {open > 0
        ? <p className={styles.muted}>Close every item above first: {open} still open.</p>
        : <p className={styles.muted}>Everything is closed. Add a note for the day if you like, then close it before you punch out.</p>}
      <div className={styles.form}>
        <label className={styles.label} htmlFor="day-close-note">Note for the day (optional)</label>
        <input id="day-close-note" className={styles.input} value={note} maxLength={2000} onChange={e => setNote(e.target.value)} />
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={`boe-btn boe-btn-primary ${styles.wide}`} onClick={close} disabled={busy || open > 0} aria-busy={busy}>
          {busy ? 'Closing…' : 'Close my day'}
        </button>
      </div>
    </section>
  )
}

function statusChip(item: Item) {
  if (item.effective === 'done') return <span className={`${styles.chip} ${styles.chipGreen}`}>Done</span>
  if (item.effective === 'not_done') return <span className={`${styles.chip} ${styles.chipAmber}`}>Not done</span>
  return <span className={`${styles.chip} ${styles.chipGrey}`}>Open</span>
}

function ItemRow({ item, filed, closed, today, onChanged }: {
  item: Item; filed: boolean; closed: boolean; today: string; onChanged: () => Promise<void>
}) {
  const [mode, setMode] = useState<null | 'done' | 'not_done'>(null)
  const [url, setUrl] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [next, setNext] = useState(istAddDays(today, 1))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cls = item.effective === 'done' ? `${styles.item} ${styles.itemDone}`
    : item.effective === 'not_done' ? `${styles.item} ${styles.itemNotDone}` : styles.item
  const handedIn = item.source === 'assigned' && item.effective === 'done' && item.status === 'open'

  const remove = async () => {
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/me', { body: { action: 'remove_item', item_id: item.id } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await onChanged()
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    let photoPath: string | null = null
    if (mode === 'done' && photo) {
      try {
        const small = await shrinkPhoto(photo)
        const up = await dayCloseFetch<{ path: string }>('/api/day-close/proof', { method: 'POST', raw: small })
        if (!up.ok) { setBusy(false); setError(up.error); return }
        photoPath = up.data.path
      } catch (e) {
        setBusy(false); setError(e instanceof Error ? e.message : 'The photo could not be prepared.'); return
      }
    }
    const body = mode === 'done'
      ? { action: 'close_item', item_id: item.id, status: 'done', proof_url: url, proof_photo_path: photoPath, proof_note: note }
      : { action: 'close_item', item_id: item.id, status: 'not_done', reason, next_date: next }
    const r = await dayCloseFetch('/api/day-close/me', { body })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setMode(null)
    await onChanged()
  }

  return (
    <li className={cls}>
      <div className={styles.itemHead}>
        <div>
          <p className={styles.itemTitle}>
            {item.source === 'assigned' && <Lock size={13} aria-label="Given to you" style={{ marginRight: 4, verticalAlign: '-1px' }} />}
            {item.title}
          </p>
          {item.expected_output && <p className={styles.itemSub}>Output: {item.expected_output}</p>}
          {item.source === 'assigned' && item.task_id && (
            <p className={styles.itemSub}>
              <Link href={`/tasks/${item.task_id}`} className={styles.proofLink}>Open the task</Link>
              {handedIn && ' · submitted in Task Management'}
            </p>
          )}
          {item.status === 'done' && item.proof_url && (
            <p className={styles.itemSub}>Proof: <a href={item.proof_url} target="_blank" rel="noreferrer" className={styles.proofLink}>{item.proof_url}</a></p>
          )}
          {item.status === 'done' && item.proof_note && <p className={styles.itemSub}>{item.proof_note}</p>}
          {item.photo_url && (
            <a href={item.photo_url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.photo_url} alt={`Proof for ${item.title}`} className={styles.proofPhoto} />
            </a>
          )}
          {item.status === 'not_done' && (
            <p className={styles.itemSub}>Why: {item.reason} · New date {item.next_date ? dayLabel(item.next_date) : '—'}</p>
          )}
        </div>
        {statusChip(item)}
      </div>

      {!closed && !filed && item.source === 'own' && (
        <div className={styles.actions}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={remove} disabled={busy}>Remove</button>
        </div>
      )}

      {!closed && filed && item.status === 'open' && mode === null && (
        <div className={styles.actions}>
          {(item.source === 'own' || handedIn) && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMode('done')}>Done</button>
          )}
          {!handedIn && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setMode('not_done')}>Not done</button>
          )}
        </div>
      )}

      {mode === 'done' && (
        <div className={styles.form}>
          {item.source === 'own' && (
            <>
              <label className={styles.label} htmlFor={`url-${item.id}`}>Link to the work (post, page, sheet, document)</label>
              <input id={`url-${item.id}`} className={styles.input} type="url" inputMode="url" value={url}
                onChange={e => setUrl(e.target.value)} placeholder="https://" />
              <label className={styles.label} htmlFor={`photo-${item.id}`}>Or a photo / screenshot</label>
              <input id={`photo-${item.id}`} type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
            </>
          )}
          <label className={styles.label} htmlFor={`note-${item.id}`}>Note (optional)</label>
          <input id={`note-${item.id}`} className={styles.input} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-primary" onClick={save} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Mark done'}</button>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { setMode(null); setError(null) }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'not_done' && (
        <div className={styles.form}>
          <label className={styles.label} htmlFor={`reason-${item.id}`}>Why is it not done?</label>
          <input id={`reason-${item.id}`} className={styles.input} value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} />
          <label className={styles.label} htmlFor={`next-${item.id}`}>When will it be done?</label>
          <input id={`next-${item.id}`} className={styles.input} type="date" value={next} min={istAddDays(today, 1)} onChange={e => setNext(e.target.value)} />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-primary" onClick={save} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { setMode(null); setError(null) }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {mode === null && error && <p className={styles.error} role="alert">{error}</p>}
    </li>
  )
}
