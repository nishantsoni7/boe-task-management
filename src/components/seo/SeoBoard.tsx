'use client'

import { useState } from 'react'
import { useSeoAccess, useSeoWrites } from '@/hooks/useSeoAccess'
import { istToday } from '@/lib/istDate'
import { seoWriteMessage } from '@/lib/seo/api'
import { pageNotes } from '@/lib/seo/pages'
import {
  STATUS_LABEL, boardCounts, dayLabel, formatCount, openProposals, progress, targets, type SeoData, type SeoPlanItem,
} from '@/lib/seo/report'
import type { SeoTone } from '@/lib/seo/sixMonth'
import { ProposalCard, type OnDecide } from './ProposalCard'
import { Check, Foot, Hero, Rows } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const TONE: Record<SeoPlanItem['status'], SeoTone> = { done: 'good', started: 'work', waiting_owner: 'wait', not_started: 'pending' }
const STATUSES = Object.keys(STATUS_LABEL) as SeoPlanItem['status'][]
const WINDOWS = [
  { key: 'd30', title: 'Next 30 days' },
  { key: 'd60', title: 'Days 31 to 60' },
] as const

const shown = (value: number | null) => (value === null ? '—' : formatCount(value))

export type OnSaveItem = (id: string, status: SeoPlanItem['status'], evidence: string) => Promise<void>

function PlanRow({ item, onSave }: { item: SeoPlanItem; onSave?: OnSaveItem }) {
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState(item.status)
  const [evidence, setEvidence] = useState(item.evidence)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!onSave) return
    setBusy(true)
    setError('')
    try {
      await onSave(item.id, status, evidence)
      setEditing(false)
    } catch (e) {
      setError(seoWriteMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${s.planRow}${item.status === 'waiting_owner' ? ` ${s.planYou}` : ''}`}>
      <span><Tag tag={{ text: STATUS_LABEL[item.status], tone: TONE[item.status] }} /></span>
      <div>
        <div className={s.strong}>{item.title}</div>
        <div className={s.planMeta}>
          {item.due_date ? `Due ${dayLabel(item.due_date)}` : 'No date'}{item.who ? ` · ${item.who}` : ''}{item.evidence && !editing ? ` · ${item.evidence}` : ''}
        </div>
        {editing && (
          <div className={s.form}>
            <label className={s.field}>
              <span className={s.small}>Status</span>
              <select className="boe-input" value={status} onChange={e => setStatus(e.target.value as SeoPlanItem['status'])} disabled={busy}>
                {STATUSES.map(option => <option key={option} value={option}>{STATUS_LABEL[option]}</option>)}
              </select>
            </label>
            <label className={s.field}>
              <span className={s.small}>What shows this{status === 'done' ? ' (needed for Done)' : ''}</span>
              <input className="boe-input" value={evidence} maxLength={1000} onChange={e => setEvidence(e.target.value)} disabled={busy} />
            </label>
            <div className={s.buttons}>
              <button className="boe-btn boe-btn-primary" onClick={save} disabled={busy}>Save</button>
              <button
                className="boe-btn boe-btn-secondary"
                onClick={() => { setStatus(item.status); setEvidence(item.evidence); setError(''); setEditing(false) }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
            {error && <p className="boe-field-error" role="alert">{error}</p>}
          </div>
        )}
      </div>
      {onSave && !editing && <button className="boe-btn boe-btn-secondary" onClick={() => setEditing(true)}>Update</button>}
    </div>
  )
}

function Window({ title, note, items, onSave }: { title: string; note?: string; items: SeoPlanItem[]; onSave?: OnSaveItem }) {
  const c = boardCounts(items)
  return (
    <section className="boe-panel" aria-label={title}>
      <Head title={title} note={note} />
      <div className={s.meter} aria-hidden="true">
        <i className={s.meterDone} style={{ flex: c.done }} />
        <i className={s.meterStarted} style={{ flex: c.started }} />
        <i className={s.meterWaiting} style={{ flex: c.waiting }} />
        <i className={s.meterLeft} style={{ flex: c.notStarted }} />
      </div>
      <div className={s.legend}><span>{c.done} done</span><span>{c.started} under way</span><span>{c.waiting} waiting on you</span><span>{c.notStarted} not started</span></div>
      {items.map(item => <PlanRow key={item.id} item={item} onSave={onSave} />)}
    </section>
  )
}

export function BoardBody({ data, today, onSave, onDecide }: { data: SeoData; today: string; onSave?: OnSaveItem; onDecide?: OnDecide }) {
  const notes = pageNotes(data, 'board')
  const numbers = targets(data, today)
  const proposals = openProposals(data)
  const achieved = progress(data)
  const c = boardCounts(data.planItems)
  const lastDue = data.planItems.map(i => i.due_date ?? '').sort().at(-1)

  return (
    <div className={s.page}>
      <Hero
        notes={notes}
        sideTitle={`${c.total} items${lastDue ? `, to ${dayLabel(lastDue)}` : ''}`}
        fallback={{ title: 'What is planned, achieved and pending' }}
        side={[
          { label: 'Done', note: '', value: String(c.done) },
          { label: 'Under way', note: '', value: String(c.started) },
          { label: 'Waiting on you', note: '', value: String(c.waiting) },
          { label: 'Not started', note: notes.checks.new_items ?? '', value: String(c.notStarted) },
        ]}
      />

      {WINDOWS.map(w => <Window key={w.key} title={w.title} note={notes.checks[w.key]} items={data.planItems.filter(i => i.window_key === w.key)} onSave={onSave} />)}

      {proposals.length > 0 && (
        <section className="boe-panel" aria-label="Strategy changes waiting for an answer">
          <Head title="Strategy changes waiting for an answer" note="Your decision. The recommendation is ours." />
          {proposals.map(p => <ProposalCard key={p.id} proposal={p} onDecide={onDecide} />)}
        </section>
      )}

      {(numbers.length > 0 || achieved.length > 0) && (
        <section className={s.two} aria-label="Numbers and progress">
          {numbers.length > 0 && (
            <div className="boe-panel">
              <Head title="Where this is heading" note="Now, November, December, April" />
              {numbers.map(n => (
                <div key={n.measure} className={s.mini}>
                  <span>{n.label}</span>
                  <span className={s.small}>{n.nowText} · {shown(n.target)} · {shown(n.december)} · <b>{shown(n.april)}</b></span>
                </div>
              ))}
              <Rows items={notes.rows} />
              <Check text={notes.checks.heading} />
            </div>
          )}
          {achieved.length > 0 && (
            <div className="boe-panel">
              <Head title="Achieved so far" />
              {achieved.map(a => (
                <div key={a.label} className={s.mini}>
                  <span>{a.label}</span>
                  <Tag tag={{ text: `${a.done} of ${a.of}`, tone: a.done ? 'work' : 'pending' }} />
                </div>
              ))}
              <Check text={notes.checks.achieved} />
            </div>
          )}
        </section>
      )}

      <Foot text={notes.foot} />
    </div>
  )
}

export function SeoBoard() {
  const { canEdit, canDecide } = useSeoAccess()
  const { saveItem, decide } = useSeoWrites()
  return (
    <SeoScreen title="Vision board" subtitle="What is planned, achieved and pending">
      {data => <BoardBody data={data} today={istToday()} onSave={canEdit ? saveItem : undefined} onDecide={canDecide ? decide : undefined} />}
    </SeoScreen>
  )
}
