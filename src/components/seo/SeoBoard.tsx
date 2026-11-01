'use client'

import { useState } from 'react'
import { useSeoAccess, useSeoWrites } from '@/hooks/useSeoAccess'
import { istToday } from '@/lib/istDate'
import { seoWriteMessage } from '@/lib/seo/api'
import {
  STATUS_LABEL, boardCounts, dayLabel, formatCount, openProposals, progress, targets, type SeoData, type SeoPlanItem,
} from '@/lib/seo/report'
import { ProposalCard, type OnDecide } from './ProposalCard'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const BADGE: Record<SeoPlanItem['status'], string> = { done: 'completed', started: 'working', waiting_owner: 'waiting', not_started: 'pending' }
const STATUSES = Object.keys(STATUS_LABEL) as SeoPlanItem['status'][]
const WINDOWS = [
  { key: 'd30', title: 'Next 30 days' },
  { key: 'd60', title: 'Days 31 to 60' },
] as const

export type OnSaveItem = (id: string, status: SeoPlanItem['status'], evidence: string) => Promise<void>

function ItemCard({ item, onSave }: { item: SeoPlanItem; onSave?: OnSaveItem }) {
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
    <div className={s.card}>
      <span className={`boe-badge boe-badge-${BADGE[item.status]} ${s.cardStatus}`}>{STATUS_LABEL[item.status]}</span>
      <span>{item.title}</span>
      <span className={s.cardMeta}>
        {item.due_date ? `Due ${dayLabel(item.due_date)}` : 'No date'}{item.who ? ` · ${item.who}` : ''}
      </span>
      {item.evidence && !editing && <span className={s.cardMeta}>{item.evidence}</span>}
      {onSave && !editing && (
        <button className={`boe-btn boe-btn-text ${s.cardStatus}`} onClick={() => setEditing(true)}>Update</button>
      )}
      {editing && (
        <div className={s.form}>
          <label className={s.field}>
            <span className={s.cardMeta}>Status</span>
            <select className="boe-input" value={status} onChange={e => setStatus(e.target.value as SeoPlanItem['status'])} disabled={busy}>
              {STATUSES.map(option => <option key={option} value={option}>{STATUS_LABEL[option]}</option>)}
            </select>
          </label>
          <label className={s.field}>
            <span className={s.cardMeta}>What shows this{status === 'done' ? ' (needed for Done)' : ''}</span>
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
  )
}

function Column({ title, items, onSave }: { title: string; items: SeoPlanItem[]; onSave?: OnSaveItem }) {
  const c = boardCounts(items)
  return (
    <section className={`boe-panel ${s.panel}`}>
      <h2 className={s.heading}>{title}</h2>
      <div className={s.meter} aria-hidden="true">
        <i style={{ flex: c.done, background: '#276247' }} />
        <i style={{ flex: c.started, background: '#335A86' }} />
        <i style={{ flex: c.waiting, background: '#805B0D' }} />
        <i style={{ flex: c.notStarted, background: '#CFC8BF' }} />
      </div>
      <p className={s.note}>{c.done} done · {c.started} started · {c.waiting} waiting on you · {c.notStarted} not started</p>
      {items.map(item => <ItemCard key={item.id} item={item} onSave={onSave} />)}
    </section>
  )
}

export function BoardBody({ data, today, onSave, onDecide }: { data: SeoData; today: string; onSave?: OnSaveItem; onDecide?: OnDecide }) {
  const numbers = targets(data, today)
  const proposals = openProposals(data)
  const achieved = progress(data)

  return (
    <div className={s.stack}>
      <div className={s.board}>
        {WINDOWS.map(w => <Column key={w.key} title={w.title} items={data.planItems.filter(i => i.window_key === w.key)} onSave={onSave} />)}
      </div>

      <div className={s.columns}>
        {numbers.length > 0 && (
          <section className={s.tight}>
            <h2 className={s.heading}>Where this is heading</h2>
            <div className={`boe-table-wrap ${s.tableScroll}`}>
              <table className="boe-table">
                <thead><tr><th>Number</th><th className="num">Now</th><th className="num">This month</th><th className="num">April</th></tr></thead>
                <tbody>
                  {numbers.map(n => (
                    <tr key={n.measure}>
                      <td>{n.measure}</td>
                      <td className="num">{n.now === null ? '—' : formatCount(n.now)}</td>
                      <td className="num">{n.target === null ? '—' : formatCount(n.target)}</td>
                      <td className="num">{n.april === null ? '—' : formatCount(n.april)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {achieved.length > 0 && (
          <section className={`boe-panel ${s.panel}`}>
            <h2 className={s.heading}>Achieved so far</h2>
            {achieved.map(a => (
              <div key={a.label} className={s.row}>
                <span>{a.label}</span>
                <span className="boe-badge boe-badge-working">{a.done} of {a.of}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {proposals.length > 0 && (
        <section className={s.tight}>
          <h2 className={s.heading}>Strategy changes waiting for an answer</h2>
          {proposals.map(p => <ProposalCard key={p.id} proposal={p} onDecide={onDecide} />)}
        </section>
      )}
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
