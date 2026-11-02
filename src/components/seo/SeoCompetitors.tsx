'use client'

import { pageNotes, percentChange, spotBars } from '@/lib/seo/pages'
import { cityTable, competitors, dayLabel, formatCount, type SeoData } from '@/lib/seo/report'
import { Check, Foot, Hero, Notes } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const figure = (value: number | null) => (value === null ? '—' : formatCount(value))

export function CompetitorsBody({ data }: { data: SeoData }) {
  const rows = competitors(data)
  if (!rows.length) return <p className={s.small}>No competitor figures saved yet.</p>
  const notes = pageNotes(data, 'competitors')
  const us = rows.find(r => r.isUs)
  const compared = rows.filter(r => r.visits !== null && r.visitsYearAgo !== null).sort((a, b) => Number(b.isUs) - Number(a.isUs) || (b.visits ?? 0) - (a.visits ?? 0))
  const others = rows.filter(r => !compared.includes(r))
  const most = Math.max(...compared.flatMap(r => [r.visits ?? 0, r.visitsYearAgo ?? 0]), 1)
  const city = cityTable(data)
  const bars = spotBars(data)
  const mostSpots = Math.max(...bars.map(b => b.count), 1)
  const dates = rows.map(r => r.asOf).sort()

  return (
    <div className={s.page}>
      <Hero
        notes={notes}
        sideTitle="Where we stand"
        fallback={{ title: 'Who is winning, and what to copy' }}
        side={[
          ...(us ? [{
            label: 'Visits a month',
            note: us.visitsYearAgo === null ? '' : `${(us.visits ?? 0) < us.visitsYearAgo ? 'Down' : 'Up'} from ${figure(us.visitsYearAgo)} a year ago`,
            value: figure(us.visits),
            tone: us.visitsYearAgo === null ? undefined : (us.visits ?? 0) < us.visitsYearAgo ? 'down' as const : 'up' as const,
          }] : []),
          ...notes.side,
          ...(us ? [{ label: 'Top-3 spots in the city checks', note: notes.checks.top3 ?? '', value: String(us.cityTop3) }] : []),
        ]}
      />

      {notes.cards.length > 0 && (
        <section className="boe-panel" aria-label="Who to watch">
          <Head title="Who to watch" note="Not the biggest sites: the ones taking buyer searches" />
          <div className={s.watchCards}>
            {notes.cards.map(card => (
              <div key={card.title} className={s.watchCard}>
                <div className={s.moveTop}><span className={s.strong}>{card.title}</span>{card.tag && <Tag tag={card.tag} />}</div>
                <div className={s.small}>{card.text}</div>
                {card.action && <div className={s.watchAction}>{card.action}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="boe-panel" aria-label="Who is rising and who is falling">
        <Head title="Who is rising, who is falling" note="Visits a month, a year ago against now" />
        <div className={`${s.rival} ${s.rowHead}`}><span>Site</span><span>A year ago, then now</span><span className={s.right}>Change</span><span className={s.right}>Strength</span></div>
        {compared.map(row => (
          <div key={row.domain} className={`${s.rival}${row.isUs ? ` ${s.rivalUs}` : ''}`}>
            <div><div className={s.strong}>{row.domain}{row.isUs ? ' (us)' : ''}</div>{row.wins && <div className={s.small}>{row.wins}</div>}</div>
            <div className={s.rivalBars}>
              <i className={s.barBefore} style={{ width: `${Math.max(((row.visitsYearAgo ?? 0) / most) * 100, 1)}%` }} title={`A year ago: ${figure(row.visitsYearAgo)}`} />
              <i className={s.barNow} style={{ width: `${Math.max(((row.visits ?? 0) / most) * 100, 1)}%` }} title={`Now: ${figure(row.visits)}`} />
            </div>
            <span className={s.right}><b className={(row.visits ?? 0) >= (row.visitsYearAgo ?? 0) ? s.up : s.down}>{percentChange(row.visits ?? 0, row.visitsYearAgo)}</b><br /><span className={s.small}>{figure(row.visits)}</span></span>
            <span className={s.right} data-label="Strength">{figure(row.strength)}</span>
          </div>
        ))}
        <Check text={notes.checks.rising} />
      </section>

      <section className={s.two} aria-label="Directories and the other sites">
        <div className="boe-panel">
          <Head title={`Directories hold ${city.totalSpots ? Math.round((city.directorySpots / city.totalSpots) * 100) : 0}% of top-3 spots`} note={`${city.directorySpots} of ${city.totalSpots}`} />
          <div className={s.lensPanel}>
            {bars.map(bar => (
              <div key={bar.label} className={`${s.bar} ${s.barShort}`}>
                <span>{bar.label}</span>
                <i className={bar.us ? s.fillTarget : s.fill} style={{ width: `${(bar.count / mostSpots) * 100}%` }} />
                <b>{bar.count}</b>
              </div>
            ))}
            {notes.checks.directories && <div className={s.small}>{notes.checks.directories}</div>}
          </div>
        </div>
        {others.length > 0 && (
          <div className="boe-panel">
            <Head title="The other sites we follow" note="Visits, strength, top-3 spots" />
            {others.map(row => (
              <div key={row.domain} className={s.mini}>
                <span><b>{row.domain}</b>{row.wins && <><br /><span className={s.small}>{row.wins}</span></>}</span>
                <span className={s.small}>{figure(row.visits)}, {figure(row.strength)}, {row.cityTop3}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {notes.rows.length > 0 && (
        <section className="boe-panel" aria-label="What winners do that we do not">
          <Head title="What winners do that we do not" note={notes.checks.practices} />
          <div className={s.practices}>
            {notes.rows.map(row => (
              <div key={row.title}>
                <div className={s.strong}>{row.title}</div>
                <div className={s.small}>{row.text}</div>
                {row.tag && <Tag tag={row.tag} />}
              </div>
            ))}
          </div>
        </section>
      )}

      <Notes items={notes.notes} />
      <Foot text={notes.foot || `Ahrefs estimates, read ${dayLabel(dates[0])} to ${dayLabel(dates[dates.length - 1])}. Top-3 spots come from the daily city checks. Strength is Ahrefs Domain Rating.`} />
    </div>
  )
}

export function SeoCompetitors() {
  return <SeoScreen title="Competitors" subtitle="Who is winning, and what to copy">{data => <CompetitorsBody data={data} />}</SeoScreen>
}
