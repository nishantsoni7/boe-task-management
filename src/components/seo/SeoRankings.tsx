'use client'

import { cityTable, dayLabel, moneyKeywords, type KeywordRow, type SeoData } from '@/lib/seo/report'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const MOVE: Record<KeywordRow['move'], { label: string; badge: string }> = {
  up: { label: 'Up', badge: 'completed' },
  down: { label: 'Down', badge: 'blocked' },
  same: { label: 'Same', badge: 'pending' },
}

export function RankingsBody({ data }: { data: SeoData }) {
  const keywords = moneyKeywords(data)
  const city = cityTable(data)

  return (
    <div className={s.stack}>
      <section className={s.tight}>
        <h2 className={s.heading}>Money keywords</h2>
        {keywords.asOf ? (
          <>
            <p className={s.note}>
              {keywords.inTop10} of {keywords.rows.length + keywords.silent.length} in Google&apos;s top 10. Search Console average position, 7 days to {dayLabel(keywords.asOf)}. Lower is better.
            </p>
            <div className={`boe-table-wrap ${s.tableScroll}`}>
              <table className="boe-table">
                <thead><tr><th>Keyword</th><th className="num">Position now</th><th className="num">7 days before</th><th>Move</th></tr></thead>
                <tbody>
                  {keywords.rows.map(row => (
                    <tr key={row.keyword}>
                      <td>{row.keyword}</td>
                      <td className="num">{row.position.toFixed(1)}</td>
                      <td className="num">{row.previous === null ? '—' : row.previous.toFixed(1)}</td>
                      <td><span className={`boe-badge boe-badge-${MOVE[row.move].badge}`}>{MOVE[row.move].label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {keywords.silent.length > 0 && <p className={s.note}>No impressions that week: {keywords.silent.join(', ')}.</p>}
          </>
        ) : <p className={s.note}>No keyword positions saved yet.</p>}
      </section>

      <section className={s.tight}>
        <h2 className={s.heading}>City by city</h2>
        {city.cities.length > 0 ? (
          <>
            <div className={`boe-table-wrap ${s.tableScroll}`}>
              <table className="boe-table">
                <thead><tr><th>City</th><th className="num">Share of demand</th><th className="num">We are top 3</th><th className="num">We are top 10</th><th>Who leads (top-3 spots)</th></tr></thead>
                <tbody>
                  {city.cities.map(row => (
                    <tr key={row.city}>
                      <td>{row.city}</td>
                      <td className="num">{row.demand === null ? '—' : `${row.demand}%`}</td>
                      <td className="num">{row.top3} of {row.searches}</td>
                      <td className="num">{row.top10} of {row.searches}</td>
                      <td>{row.leaders.map(l => `${l.domain} ${l.spots}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.note}>
              Latest reading for each search, newest {city.asOf ? dayLabel(city.asOf) : '—'}. Who leads leaves out directories, which hold {city.directorySpots} of the {city.totalSpots} top-3 spots.
            </p>
          </>
        ) : <p className={s.note}>No city results saved yet.</p>}
      </section>
    </div>
  )
}

export function SeoRankings() {
  return <SeoScreen title="Rankings" subtitle="The 20 money keywords and the 8 cities">{data => <RankingsBody data={data} />}</SeoScreen>
}
