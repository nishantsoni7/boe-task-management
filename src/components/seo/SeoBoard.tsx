'use client'

import { istToday } from '@/lib/istDate'
import {
  STATUS_LABEL, boardCounts, dayLabel, formatCount, openProposals, progress, targets, type SeoData, type SeoPlanItem,
} from '@/lib/seo/report'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const BADGE: Record<SeoPlanItem['status'], string> = { done: 'completed', started: 'working', waiting_owner: 'waiting', not_started: 'pending' }
const WINDOWS = [
  { key: 'd30', title: 'Next 30 days' },
  { key: 'd60', title: 'Days 31 to 60' },
] as const

function Column({ title, items }: { title: string; items: SeoPlanItem[] }) {
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
      {items.map(item => (
        <div key={item.id} className={s.card}>
          <span className={`boe-badge boe-badge-${BADGE[item.status]} ${s.cardStatus}`}>{STATUS_LABEL[item.status]}</span>
          <span>{item.title}</span>
          <span className={s.cardMeta}>
            {item.due_date ? `Due ${dayLabel(item.due_date)}` : 'No date'}{item.who ? ` · ${item.who}` : ''}
          </span>
          {item.evidence && <span className={s.cardMeta}>{item.evidence}</span>}
        </div>
      ))}
    </section>
  )
}

export function BoardBody({ data, today }: { data: SeoData; today: string }) {
  const numbers = targets(data, today)
  const proposals = openProposals(data)
  const achieved = progress(data)

  return (
    <div className={s.stack}>
      <div className={s.board}>
        {WINDOWS.map(w => <Column key={w.key} title={w.title} items={data.planItems.filter(i => i.window_key === w.key)} />)}
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
        <section className={`boe-panel ${s.panel}`}>
          <h2 className={s.heading}>Strategy changes waiting for your answer</h2>
          {proposals.map(p => (
            <div key={p.id} className={s.tight}>
              <span className={s.text}>{p.title}</span>
              {p.body && <span className={s.note}>{p.body}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

export function SeoBoard() {
  return <SeoScreen title="Vision board" subtitle="What is planned, achieved and pending">{data => <BoardBody data={data} today={istToday()} />}</SeoScreen>
}
