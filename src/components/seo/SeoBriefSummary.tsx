'use client'

import type { ReactNode } from 'react'
import { MOVES, share, tally, tallyByGroup, type Move } from '@/lib/seo/moves'
import type { BriefCase, BriefSummary, SeoTone, SummaryChart } from '@/lib/seo/sixMonth'
import { Head } from './SeoSixMonth'
import s from './sixMonth.module.css'

// The short version at the top of the brief: conclusions first, each with the chart that proves it. Colours carry
// meaning (green better, red worse, grey unchanged), and every colour is also named in a legend with its number, so
// nothing depends on seeing the colour. The searches are counted here from the rankings rows, never typed into the data.

export const MOVE_LABEL: Record<Move, string> = {
  up: 'Improved',
  same: 'About the same',
  down: 'Fell',
  out: 'Dropped out of Google\'s view',
  new: 'Newly in view',
  thin: 'Too few showings to judge',
}
const MOVE_CLASS: Record<Move, string> = { up: s.mUp, same: s.mSame, down: s.mDown, out: s.mOut, new: s.mNew, thin: s.mThin }
const TONE_CLASS: Record<SeoTone, string> = { good: s.mUp, bad: s.mDown, wait: s.mWait, work: s.mNew, pending: s.mSame }
const SECTION_CLASS: Partial<Record<SeoTone, string>> = { good: s.sumGood, bad: s.sumBad, wait: s.sumWait }
const fmt = (n: number) => n.toLocaleString('en-IN')

type Slice = { key: string; label: string; value: number; cls: string; hatch?: boolean }
const RADIUS = 54
const CIRCLE = 2 * Math.PI * RADIUS
const GAP = 2 // a thin surface gap between slices, so neighbours never merge

function Donut({ slices, centre, caption, label }: { slices: Slice[]; centre: string; caption: string; label: string }) {
  const total = slices.reduce((t, x) => t + x.value, 0) || 1
  return (
    <svg viewBox="0 0 140 140" role="img" aria-label={label} className={s.donut}>
      <defs>
        <pattern id="seoHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" style={{ fill: 'var(--boe-blocked-bg)' }} />
          <line x1="0" y1="0" x2="0" y2="6" strokeWidth="3" style={{ stroke: 'var(--boe-blocked-fg)' }} />
        </pattern>
      </defs>
      <g transform="rotate(-90 70 70)">
        {slices.map((slice, i) => slice.value > 0 && (
          <circle
            key={slice.key} cx="70" cy="70" r={RADIUS} fill="none" strokeWidth="18"
            className={slice.cls} stroke={slice.hatch ? 'url(#seoHatch)' : undefined}
            strokeDasharray={`${Math.max((slice.value / total) * CIRCLE - GAP, 0.01)} ${CIRCLE}`}
            strokeDashoffset={-(slices.slice(0, i).reduce((t, x) => t + x.value, 0) / total) * CIRCLE}
          >
            <title>{`${slice.label}: ${fmt(slice.value)}`}</title>
          </circle>
        ))}
      </g>
      <text x="70" y="70" textAnchor="middle" className={s.donutValue}>{centre}</text>
      <text x="70" y="87" textAnchor="middle" className={s.donutCaption}>{caption}</text>
    </svg>
  )
}

function Legend({ slices, total }: { slices: Slice[]; total?: number }) {
  return (
    <ul className={s.sumLegend}>
      {slices.map(slice => (
        <li key={slice.key}>
          <i className={`${slice.cls} ${slice.hatch ? s.swatchHatch : ''}`} aria-hidden />
          <span>{slice.label}</span>
          <b>{fmt(slice.value)}</b>
          {total !== undefined && <small>{share(slice.value, total)}%</small>}
        </li>
      ))}
    </ul>
  )
}

const Card = ({ chart, wide, children }: { chart: SummaryChart; wide?: boolean; children: ReactNode }) => (
  <figure className={`${s.chartCard} ${wide ? s.chartWide : ''}`}>
    <figcaption><b>{chart.title}</b>{chart.note && <span>{chart.note}</span>}</figcaption>
    {children}
  </figure>
)

/** The percentage is of the searches Google showed us 20+ times in the first column: the ones that can be compared. */
function Tally({ chart, rows, first }: { chart: SummaryChart; rows: BriefCase['quarters']['rows']; first: string }) {
  const t = tally(rows)
  const lost = t.down + t.out
  const base = t.up + t.same + t.down + t.out
  const slices: Slice[] = MOVES.map(move => ({ key: move, label: MOVE_LABEL[move], value: t[move], cls: MOVE_CLASS[move], hatch: move === 'out' }))
  return (
    <Card chart={chart}>
      <div className={s.donutRow}>
        <Donut slices={slices} centre={`${share(lost, base)}%`} caption="lost ground" label={`${lost} of ${base} searches shown a year ago fell or dropped out of Google's view; ${t.up} improved.`} />
        <Legend slices={slices} />
      </div>
      <p className={s.chartSentence}>
        Of the {base} searches Google showed us at least 20 times in {first}, <b className={s.up}>{t.up} improved</b> and {t.same} held.{' '}
        <b className={s.down}>{t.down} fell</b>{t.avgDown !== null && ` (by ${t.avgDown.toFixed(1)} places on average)`} and{' '}
        <b className={s.down}>{t.out} dropped out of Google&apos;s view</b>: {lost} in all, about {share(lost, base)}%.
        {' '}Not compared: {t.new} newly in view, {t.thin} with too few showings to judge.
      </p>
    </Card>
  )
}

function Categories({ chart, rows }: { chart: SummaryChart; rows: BriefCase['quarters']['rows'] }) {
  const groups = tallyByGroup(rows)
  const most = Math.max(...groups.map(g => g.tally.total), 1)
  return (
    <Card chart={chart} wide>
      <ul className={s.legendRow}>
        {MOVES.map(move => <li key={move}><i className={`${MOVE_CLASS[move]} ${move === 'out' ? s.swatchHatch : ''}`} aria-hidden /><span>{MOVE_LABEL[move]}</span></li>)}
      </ul>
      <div className={s.catRows}>
        {groups.map(({ group, tally: t }) => (
          <div key={group} className={s.catRow}>
            <span className={s.catName}>{group}</span>
            <div className={s.catTrack}>
              <div className={s.catBar} style={{ width: `${(t.total / most) * 100}%` }} role="img"
                aria-label={`${group}: ${t.up} improved, ${t.same} about the same, ${t.down} fell, ${t.out} dropped out, ${t.new} new, ${t.thin} too few showings`}>
                {MOVES.map(move => t[move] > 0 && <i key={move} className={`${MOVE_CLASS[move]} ${move === 'out' ? s.swatchHatch : ''}`} style={{ flex: t[move] }} />)}
              </div>
            </div>
            <span className={s.catCount}><b className={s.up}>▲{t.up}</b> <b className={s.down}>▼{t.down + t.out}</b></span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Bars({ chart }: { chart: SummaryChart }) {
  const items = chart.items ?? []
  const most = Math.max(...items.map(item => item.value), 1)
  return (
    <Card chart={chart}>
      <div className={s.vbars} role="img" aria-label={`${chart.title}: ${items.map(item => `${item.label} ${fmt(item.value)}`).join(', ')}`}>
        {items.map(item => (
          <div key={item.label} className={s.vbar}>
            <b>{fmt(item.value)}</b>
            <div className={s.vbarTrack}><i className={TONE_CLASS[item.tone ?? 'work']} style={{ height: `${(item.value / most) * 100}%` }} /></div>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Pie({ chart }: { chart: SummaryChart }) {
  const slices: Slice[] = (chart.items ?? []).map(item => ({ key: item.label, label: item.label, value: item.value, cls: TONE_CLASS[item.tone ?? 'work'] }))
  const total = slices.reduce((t, x) => t + x.value, 0)
  return (
    <Card chart={chart}>
      <div className={s.donutRow}>
        <Donut slices={slices} centre={fmt(total)} caption="clicks a month" label={`${chart.title}: ${slices.map(x => `${x.label} ${share(x.value, total)}%`).join(', ')}`} />
        <Legend slices={slices} total={total} />
      </div>
    </Card>
  )
}

function ChartView({ chart, quarters }: { chart: SummaryChart; quarters?: BriefCase['quarters'] }) {
  if (chart.kind === 'bars') return <Bars chart={chart} />
  if (chart.kind === 'pie') return <Pie chart={chart} />
  if (!quarters) return null
  return chart.kind === 'tally' ? <Tally chart={chart} rows={quarters.rows} first={quarters.columns[0]} /> : <Categories chart={chart} rows={quarters.rows} />
}

/** The short version: each section's conclusion, figures, charts and reasons, then where the numbers come from. */
export function SummaryBlock({ summary, quarters, title, note }: { summary: BriefSummary; quarters?: BriefCase['quarters']; title?: string; note?: string }) {
  return (
    <section className={`boe-panel ${s.sum}`} aria-label={title ?? summary.title}>
      <Head title={title ?? summary.title} note={note ?? summary.note} />
      {summary.sections.map((section, index) => (
        <div key={section.title} className={`${s.sumSection} ${SECTION_CLASS[section.tone ?? 'wait'] ?? ''}`}>
          <div className={s.sumTop}><span className={s.number}>{index + 1}</span><h3 className={s.sumTitle}>{section.title}</h3></div>
          <p className={s.sumLead}>{section.lead}</p>
          {section.figures && (
            <div className={s.sumFigures}>
              {section.figures.map(figure => (
                <div key={figure.label} className={s.sumFigure}>
                  <b className={figure.tone === 'good' ? s.up : figure.tone === 'bad' ? s.down : undefined}>{figure.value}</b>
                  <span>{figure.label}</span>
                  {figure.note && <small>{figure.note}</small>}
                </div>
              ))}
            </div>
          )}
          {section.charts && <div className={s.sumCharts}>{section.charts.map(chart => <ChartView key={`${chart.kind}-${chart.title}`} chart={chart} quarters={quarters} />)}</div>}
          {section.points && (
            <ul className={s.sumPoints}>
              {section.points.map(point => <li key={point.title}><b>{point.title}</b> <span>{point.text}</span></li>)}
            </ul>
          )}
        </div>
      ))}
      <div className={s.sourceBox}>
        <div className={s.sourceTitle}>{summary.source.title}</div>
        <p className={s.small}>{summary.source.text}</p>
        <ul className={s.bullets}>{summary.source.points.map(point => <li key={point}>{point}</li>)}</ul>
      </div>
    </section>
  )
}
