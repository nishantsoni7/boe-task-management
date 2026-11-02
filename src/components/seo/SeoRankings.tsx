'use client'

import { indiaKeywords, pageNotes, type IndiaKeyword } from '@/lib/seo/pages'
import { cityTable, dayLabel, formatCount, type SeoData } from '@/lib/seo/report'
import { Check, Foot, Hero, Notes } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head } from './SeoSixMonth'
import s from './sixMonth.module.css'

const AXIS = [1, 10, 20, 30, 40]
const across = (position: number) => ((Math.min(Math.max(position, 1), 40) - 1) / 39) * 100

function Track({ was, now }: { was: number | null; now: number }) {
  const before = was ?? now
  const fell = now > before + 1
  const rose = now < before - 1
  const [left, right] = [across(before), across(now)].sort((a, b) => a - b)
  return (
    <div className={s.track}>
      <i className={fell ? s.lineFell : rose ? s.lineRose : s.lineSame} style={{ left: `${left}%`, width: `${right - left}%` }} />
      {was !== null && <b className={s.was} style={{ left: `${across(before)}%` }} />}
      <b className={fell ? s.nowFell : rose ? s.nowRose : s.nowSame} style={{ left: `${across(now)}%` }} />
    </div>
  )
}

function KeywordRow({ row }: { row: IndiaKeyword }) {
  return (
    <div className={s.keyword}>
      <span className={s.keywordName}>{row.keyword}</span>
      <span className={s.right} data-label="Searches a month">{row.demand || '—'}</span>
      <Track was={row.previous} now={row.position} />
      <span className={s.right} data-label="Position">{row.previous === null ? '—' : row.previous.toFixed(1)} → {row.position.toFixed(1)}</span>
      <span className={s.right} data-label="Clicks / views">{row.clicks} / {formatCount(row.views)}</span>
      <span className={`${s.keywordStep} ${row.step ? '' : s.small}`}>{row.step || 'Too few views to act on'}</span>
    </div>
  )
}

export function RankingsBody({ data }: { data: SeoData }) {
  const notes = pageNotes(data, 'rankings')
  const k = indiaKeywords(data)
  const city = cityTable(data)

  return (
    <div className={s.page}>
      <Hero
        notes={notes}
        sideTitle="India, last 28 days"
        fallback={{ title: k.rows.length ? `${k.page1} of ${k.rows.length} are on page 1` : 'No India keyword reading saved yet.' }}
        side={[
          { label: 'On page 1', note: `${k.real} with 100 or more views`, value: String(k.page1) },
          { label: 'Page 2', note: 'Where the quickest wins are', value: String(k.page2) },
          { label: 'Page 3 or lower', note: '', value: String(k.page3) },
          { label: `Clicks from all ${k.rows.length}`, note: `From ${formatCount(k.views)} views, was ${k.clicksBefore} from ${formatCount(k.viewsBefore)}`, value: String(k.clicks) },
        ]}
      />

      {k.main.length > 0 && (
        <section className="boe-panel" aria-label="Where the searches are">
          <Head title="Where the searches are" note="Biggest demand first. Left is better." />
          <div className={`${s.keyword} ${s.rowHead}`}>
            <span>Keyword</span><span className={s.right}>Searches a month</span><span>Position</span><span className={s.right}>28 days ago → now</span><span className={s.right}>Clicks / views</span><span className={s.keywordStep}>What Google shows, and the next step</span>
          </div>
          {k.main.map(row => <KeywordRow key={row.keyword} row={row} />)}
          <div className={`${s.keyword} ${s.axisRow}`}>
            <span /><span />
            <div className={s.axis}>{AXIS.map(position => <span key={position} style={{ left: `${across(position)}%` }}>{position}</span>)}</div>
          </div>
        </section>
      )}

      {k.wrong.length > 0 && (
        <section className="boe-panel" aria-label="Google shows the wrong page">
          <Head title="Google shows the wrong page" note="Each search needs one page of ours" />
          <div className={`${s.wrongPage} ${s.rowHead}`}><span>Search</span><span>What Google shows</span><span>The page that should rank</span></div>
          {k.wrong.map(row => (
            <div key={row.keyword} className={s.wrongPage}>
              <div><div className={s.strong}>{row.keyword}</div>{row.demand && <div className={s.small}>{row.demand} searches a month</div>}</div>
              <div className={s.url}>{row.shown.map(page => <div key={page}>{page}</div>)}</div>
              <div className={s.urlWant}>{row.want}</div>
            </div>
          ))}
          <Check text={notes.checks.wrong} />
        </section>
      )}

      <section className="boe-panel" aria-label="City by city">
        <Head title="City by city" note="7 searches a city. Big cities first." />
        {city.cities.length > 0 ? (
          <>
            <div className={`${s.cityRow} ${s.rowHead}`}><span>City</span><span>Share of demand</span><span>Top 3 and top 10</span><span>We hold</span><span className={s.keywordStep}>Who leads, leaving out directories</span></div>
            {city.cities.map(row => (
              <div key={row.city} className={s.cityRow}>
                <span className={s.strong}>{row.city}</span>
                <span>{row.demand === null ? 'No data' : `${row.demand}%`}</span>
                <div className={s.pips} role="img" aria-label={`${row.top3} of ${row.searches} in the top 3, ${row.top10} of ${row.searches} in the top 10`}>
                  {Array.from({ length: row.searches }, (_, index) => <s key={index} className={index < row.top3 ? s.pipTop3 : index < row.top10 ? s.pipTop10 : undefined} />)}
                </div>
                <span className={s.small}>{row.top3} in top 3, {row.top10} in top 10</span>
                <span className={`${s.small} ${s.keywordStep}`}>{row.leaders.map(l => `${l.domain} ${l.spots}`).join(', ') || '—'}</span>
              </div>
            ))}
            <div className={s.legend}>
              <span>Dark green: top 3</span><span>Light green: top 10</span><span>Grey: not in the top 10</span>
              <span>Directories hold {city.directorySpots} of {city.totalSpots} top-3 spots</span>
              {city.asOf && <span>Newest reading {dayLabel(city.asOf)}</span>}
            </div>
            <Check text={notes.checks.city} />
          </>
        ) : <div className={s.mini}><span>No city results saved yet.</span></div>}
      </section>

      {k.thin.length > 0 && (
        <section className="boe-panel" aria-label="Too few views to act on">
          <Head title="Too few views to act on" note="Watch these, but do not judge them yet" />
          {k.thin.map(row => <KeywordRow key={row.keyword} row={row} />)}
        </section>
      )}

      <Notes items={notes.notes} />
      <Foot text={notes.foot} />
    </div>
  )
}

export function SeoRankings() {
  return <SeoScreen title="Rankings" subtitle="The 20 money keywords and the 8 cities, India only">{data => <RankingsBody data={data} />}</SeoScreen>
}
