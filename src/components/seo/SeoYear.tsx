'use client'

import { dayLabel, formatCount, halfOnHalf, months, pageGroups, workCounts, workLog, type SeoData } from '@/lib/seo/report'
import { MonthBars } from './MonthBars'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const signed = (percent: number) => `${percent > 0 ? '+' : ''}${percent}%`

function change(before: number | null, after: number) {
  return before ? signed(Math.round(((after - before) / before) * 100)) : '—'
}

export function YearBody({ data }: { data: SeoData }) {
  const rows = months(data)
  const clicks = halfOnHalf(rows.map(r => r.clicks))
  const leads = halfOnHalf(rows.map(r => r.leads))
  const groups = pageGroups(data)
  const counts = workCounts(data)
  const log = workLog(data)
  const most = Math.max(...counts.map(c => c.count), 1)

  return (
    <div className={s.stack}>
      {rows.length > 0 ? (
        <div className={s.columns}>
          <section className={`boe-panel ${s.panel}`}><MonthBars title="Search clicks per month" bars={rows.map(r => ({ label: r.label, value: r.clicks }))} /></section>
          <section className={`boe-panel ${s.panel}`}><MonthBars title="Website leads per month" bars={rows.map(r => ({ label: r.label, value: r.leads }))} /></section>
        </div>
      ) : <p className={s.note}>No monthly figures saved yet.</p>}

      {clicks && leads && (
        <p className={s.text}>
          The last six months against the six before: clicks {signed(clicks.percent)} ({formatCount(clicks.before)} to {formatCount(clicks.after)}), website leads {signed(leads.percent)} ({formatCount(leads.before)} to {formatCount(leads.after)}).
        </p>
      )}

      {groups.length > 0 && (
        <section className={s.tight}>
          <h2 className={s.heading}>Where the clicks go</h2>
          <div className={`boe-table-wrap ${s.tableScroll}`}>
            <table className="boe-table">
              <thead><tr><th>Pages</th><th className="num">Last 6 months</th><th className="num">6 months before</th><th className="num">Change</th></tr></thead>
              <tbody>
                {groups.map(g => (
                  <tr key={g.group}>
                    <td>{g.group}</td>
                    <td className="num">{formatCount(g.clicks)}</td>
                    <td className="num">{g.before === null ? '—' : formatCount(g.before)}</td>
                    <td className="num">{change(g.before, g.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className={s.columns}>
        {counts.length > 0 && (
          <section className={`boe-panel ${s.panel}`}>
            <h2 className={s.heading}>SEO worksheet, April to October 2026</h2>
            {counts.map(c => (
              <div key={c.label} className={s.bar}>
                <span>{c.label}</span>
                <span className={s.barTrack}>
                  <i className={`${s.barFill}${c.useful ? ` ${s.barFillUseful}` : ''}`} style={{ width: `${(c.count / most) * 100}%` }} />
                </span>
                <span className={s.barValue}>{formatCount(c.count)}</span>
              </div>
            ))}
            <p className={s.note}>Green is work that can move rankings. November 2025 to March 2026 is not counted yet.</p>
          </section>
        )}
        {log.length > 0 && (
          <section className={`boe-panel ${s.panel}`}>
            <h2 className={s.heading}>Changes made</h2>
            {log.map(entry => (
              <div key={entry.id} className={s.tight}>
                <span className={s.cardMeta}>{dayLabel(entry.log_date)}{entry.source ? ` · ${entry.source}` : ''}</span>
                <span className={s.text}>{entry.title}</span>
                {entry.before_value && entry.after_value && <span className={s.note}>{entry.before_value} to {entry.after_value}</span>}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

export function SeoYear() {
  return <SeoScreen title="Year review" subtitle="The last 12 months and the work done">{data => <YearBody data={data} />}</SeoScreen>
}
