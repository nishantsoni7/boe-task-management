'use client'

import { competitors, dayLabel, formatCount, type SeoData } from '@/lib/seo/report'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const figure = (value: number | null) => (value === null ? '—' : formatCount(value))

export function CompetitorsBody({ data }: { data: SeoData }) {
  const rows = competitors(data)
  if (!rows.length) return <p className={s.note}>No competitor figures saved yet.</p>
  return (
    <div className={s.tight}>
      <div className={`boe-table-wrap ${s.tableScroll}`}>
        <table className="boe-table">
          <thead>
            <tr>
              <th>Site</th><th>Where it wins</th><th className="num">Strength (DR)</th><th className="num">Linking sites</th>
              <th className="num">Keywords</th><th className="num">Visits now</th><th className="num">Year ago</th>
              <th className="num">City top-3 spots</th><th>Read on</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.domain} className={row.isUs ? s.us : undefined}>
                <td>{row.domain}{row.isUs ? ' (us)' : ''}</td>
                <td>{row.wins ?? '—'}</td>
                <td className="num">{figure(row.strength)}</td>
                <td className="num">{figure(row.linkingSites)}</td>
                <td className="num">{figure(row.keywords)}</td>
                <td className="num">{figure(row.visits)}</td>
                <td className="num">{figure(row.visitsYearAgo)}</td>
                <td className="num">{row.cityTop3}</td>
                <td>{dayLabel(row.asOf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>Ahrefs estimates, so use them to compare sites. Our real figures are in Search Console. Each site refreshes about every 5 days.</p>
    </div>
  )
}

export function SeoCompetitors() {
  return <SeoScreen title="Competitors" subtitle="Who is winning, and how strong they are">{data => <CompetitorsBody data={data} />}</SeoScreen>
}
