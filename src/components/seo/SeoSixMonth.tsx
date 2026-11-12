'use client'

import { ChevronDown } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { CSSProperties } from 'react'
import type { SeoFinding, SeoMover, SeoTag, SeoTone, SixMonthReview } from '@/lib/seo/sixMonth'
import { SeoScreen } from './SeoScreen'
import { VerdictPanel } from './seoParts'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import s from './sixMonth.module.css'

const BADGE: Record<SeoTone, string> = {
  good: 'boe-badge-completed', bad: 'boe-badge-blocked', wait: 'boe-badge-waiting', work: 'boe-badge-working', pending: 'boe-badge-pending',
}
const TEXT: Partial<Record<SeoTone, string>> = { good: s.up, bad: s.down }

export function Tag({ tag, className = '' }: { tag: SeoTag; className?: string }) {
  return <span className={`boe-badge ${s.tag} ${BADGE[tag.tone]} ${className}`}>{tag.text}</span>
}

export const Head = ({ title, note }: { title: string; note?: string }) => (
  <div className={s.head}><h2 className={s.title}>{title}</h2><span className={s.note}>{note}</span></div>
)

function Findings({ tag, note, items }: { tag: SeoTag; note: string; items: SeoFinding[] }) {
  return (
    <div className="boe-panel">
      <div className={s.head}><Tag tag={tag} /><span className={s.note}>{note}</span></div>
      {items.map(item => (
        <details key={item.title} className={s.item}>
          <summary>
            <span className={`${s.itemValue} ${TEXT[tag.tone] ?? ''}`}>{item.value}</span>
            <span className={s.itemTitle}>{item.title}</span>
            <Tag tag={item.tag} className={s.itemTag} />
            <ChevronDown className={s.chevron} size={14} aria-hidden />
          </summary>
          <div className={s.proof}>
            {item.lines.map(line => <span key={line.text}>{line.label && <b>{line.label}: </b>}{line.text}</span>)}
          </div>
        </details>
      ))}
    </div>
  )
}

function Timeline({ data }: { data: SixMonthReview['timeline'] }) {
  const months = { '--months': data.months.length } as CSSProperties
  const periods = data.periods.map((period, index) => {
    const from = data.periods.slice(0, index).reduce((sum, earlier) => sum + earlier.months, 0)
    return { label: period.label, grid: `${from + 2} / span ${period.months}`, from, to: from + period.months }
  })
  const bandOf = (month: number) => periods.findIndex(p => month >= p.from && month < p.to)

  return (
    <section className="boe-panel">
      <Head title={data.title} note={data.note} />
      <div className={s.timeWrap}>
        <div className={s.time} role="img" aria-label={`${data.rows.map(r => r.label).join(', ')}, month by month, with ${data.events.length} numbered events.`} style={months}>
          <div className={s.timeRow}>
            <span />
            {periods.map(p => <span key={p.label} className={s.band} style={{ gridColumn: p.grid }}>{p.label}</span>)}
          </div>
          <div className={s.timeRow}>
            <span className={s.timeLabel}>Events</span>
            {data.events.map((event, index) => <span key={event.text} className={s.dot} style={{ gridColumn: event.month + 2 }}>{index + 1}</span>)}
          </div>
          {data.rows.map(row => {
            const most = Math.max(...row.values, 1)
            return (
              <div key={row.label}>
                <div className={s.phoneLabel}>{row.label}</div>
                <div className={s.timeRow}>
                  <span />
                  {periods.map((p, i) => <span key={p.label} className={s.total} style={{ gridColumn: p.grid }}>{row.totals[i]}</span>)}
                </div>
                <div className={`${s.timeRow} ${s.bars}`}>
                  <span className={s.timeLabel}>{row.label}</span>
                  {row.values.map((value, i) => (
                    <i key={data.months[i]} className={s[`band${bandOf(i)}`]} style={{ height: `${Math.round((value / most) * 100)}%` }} title={`${data.months[i]}: ${value.toLocaleString('en-IN')}`} />
                  ))}
                </div>
              </div>
            )
          })}
          <div className={s.timeRow}>
            <span />
            {data.months.map(month => <span key={month} className={s.monthLetter}>{month[0]}</span>)}
          </div>
        </div>
      </div>
      <div className={s.events}>
        {data.events.map((event, index) => <div key={event.text} className={s.event}><span className={s.dot}>{index + 1}</span><span>{event.text}</span></div>)}
      </div>
      <details className={s.figures}>
        <summary>See the monthly figures</summary>
        <PhoneTableCards className={s.tableWrap}><Table head={data.table.head} rows={data.table.rows} /></PhoneTableCards>
      </details>
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className={s.table}>
      <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.join()}>{row.map((cell, i) => <td key={`${i}-${cell}`}>{cell}</td>)}</tr>)}</tbody>
    </table>
  )
}

// A position on Google, from 1 at the left edge to 40 at the right. Anything deeper sits at the edge.
const AXIS = [1, 10, 20, 30, 40]
const across = (position: number) => (Math.min(Math.max(position, 1), 40) - 1) / 39 * 100

function Mover({ item }: { item: SeoMover }) {
  const fell = item.now > item.was
  const [left, right] = [across(item.was), across(item.now)].sort((a, b) => a - b)
  return (
    <div className={s.mover}>
      <span className={s.term}>{item.term}</span>
      <div className={s.track}>
        <i className={fell ? s.lineFell : s.lineRose} style={{ left: `${left}%`, width: `${right - left}%` }} />
        <b className={s.was} style={{ left: `${across(item.was)}%` }} />
        <b className={fell ? s.nowFell : s.nowRose} style={{ left: `${across(item.now)}%` }} />
      </div>
      <span className={s.movement}>{item.was.toFixed(1)} → {item.now.toFixed(1)}</span>
    </div>
  )
}

function Movers({ tag, group }: { tag: SeoTag; group: SixMonthReview['moved']['fell'] }) {
  return (
    <div className={s.moverColumn}>
      <div className={s.moverHead}><Tag tag={tag} /><span className={s.note}>{group.note}</span></div>
      {group.items.map(item => <Mover key={item.term} item={item} />)}
      <div className={`${s.mover} ${s.axisRow}`}>
        <span className={s.term} />
        <div className={s.axis}>{AXIS.map(position => <span key={position} style={{ left: `${across(position)}%` }}>{position}</span>)}</div>
        <span />
      </div>
    </div>
  )
}

export function ReviewBody({ review }: { review: SixMonthReview }) {
  const { verdict, headline, causes, moves, targets, notes, moved, searched, ranks, spots, measures, ai, gaps } = review
  const mostSpots = Math.max(...spots.rows.map(r => r.value), 1)

  return (
    <div className={s.page}>
      <VerdictPanel
        kicker={`${review.period} in one line`}
        title={verdict.title}
        text={verdict.text}
        lenses={verdict.lenses}
        sideTitle={headline.title}
        side={headline.items.map(item => ({ label: item.label, note: item.note, value: item.value, valueClass: item.tone ? TEXT[item.tone] : undefined }))}
      />

      <section className="boe-panel" aria-label={causes.title}>
        <Head title={causes.title} note={causes.note} />
        <div className={s.causes}>
          {causes.items.map(cause => (
            <div key={cause.label} className={s.cause}>
              <div className={`${s.bigValue} ${cause.tone ? TEXT[cause.tone] ?? '' : ''}`}>{cause.value}</div>
              <div className={s.strong}>{cause.label}</div>
              <div className={s.small}>{cause.text}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={s.two} aria-label="Top good and bad things">
        <Findings tag={{ text: 'Top 5 good things', tone: 'good' }} note="Open any line for the proof" items={review.good} />
        <Findings tag={{ text: 'Top 5 bad things', tone: 'bad' }} note="Open any line for the fix" items={review.bad} />
      </section>

      <section className="boe-panel" aria-label={moves.title}>
        <Head title={moves.title} note={moves.note} />
        <div className={s.moves}>
          {moves.items.map((move, index) => (
            <div key={move.title} className={s.move}>
              <div className={s.moveTop}><span className={s.number}>{index + 1}</span><Tag tag={move.tag} /></div>
              <div className={s.strong}>{move.title}</div>
              <div className={s.small}>{move.text}</div>
            </div>
          ))}
        </div>
        {moves.then && <div className={s.strip}><Tag tag={{ text: 'Then', tone: 'pending' }} /><span>{moves.then}</span></div>}
      </section>

      <section className="boe-panel" aria-label={targets.title}>
        <Head title={targets.title} note={targets.note} />
        <div className={s.targets}>
          {targets.items.map(item => (
            <div key={item.value} className={s.target}><div className={s.bigValue}>{item.value}</div><div className={s.small}>{item.text}</div></div>
          ))}
        </div>
        {targets.warning && <div className={s.strip}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /><span>{targets.warning}</span></div>}
      </section>

      <section className="boe-panel" aria-label={notes.title}>
        <div className={s.head}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /><h2 className={s.title}>{notes.title}</h2></div>
        <div className={s.notes}>
          {notes.items.map(note => <p key={note.label}><b>{note.label}</b> {note.text}</p>)}
        </div>
      </section>

      <Timeline data={review.timeline} />

      <section className="boe-panel" aria-label={moved.title}>
        <Head title={moved.title} note={moved.note} />
        <div className={s.moved}>
          <Movers tag={{ text: 'Fell', tone: 'bad' }} group={moved.fell} />
          <Movers tag={{ text: 'Rose', tone: 'good' }} group={moved.rose} />
        </div>
        <div className={s.legend}><span><s className={s.keyWas} />A year ago</span><span><s className={s.keyNow} />Now</span><span><s className={s.keyPage} />Page 1 of Google</span></div>
      </section>

      <section className={s.three} aria-label="Expert views">
        <div className={`boe-panel ${s.lensPanel}`}>
          <div><h2 className={s.title}>{searched.title}</h2><div className={s.small}>{searched.note}</div></div>
          {searched.rows.map(row => (
            <div key={row.label} className={s.bar}>
              <span>{row.label}</span>
              <i className={row.target ? s.fillTarget : s.fill} style={{ width: `${row.share}%` }} />
              <b>{row.value}</b>
              <em className={row.tone ? TEXT[row.tone] : undefined}>{row.change}</em>
            </div>
          ))}
          <div className={s.small}>{searched.foot}</div>
        </div>
        <div className={`boe-panel ${s.lensPanel}`}>
          <div><h2 className={s.title}>{ranks.title}</h2><div className={s.small}>{ranks.note}</div></div>
          <div className={s.stacks}>
            {ranks.rows.map(row => (
              <div key={row.label} className={s.stackRow}>
                <span>{row.label}</span>
                <div className={s.rankBar}>{row.parts.map((part, i) => <i key={`${i}-${part}`} className={s[`rank${i}`]} style={{ flex: part }}>{part}</i>)}</div>
              </div>
            ))}
          </div>
          <div className={s.legendTight}>{ranks.legend.map((label, i) => <span key={label}><s className={s[`rank${i}`]} />{label}</span>)}</div>
          <div className={s.small}>{ranks.foot}</div>
        </div>
        <div className={`boe-panel ${s.lensPanel}`}>
          <div><h2 className={s.title}>{spots.title}</h2><div className={s.small}>{spots.note}</div></div>
          {spots.rows.map(row => (
            <div key={row.label} className={`${s.bar} ${s.barShort}`}>
              <span>{row.label}</span>
              <i className={row.target ? s.fillTarget : s.fill} style={{ width: `${(row.value / mostSpots) * 100}%` }} />
              <b>{row.value}</b>
            </div>
          ))}
          <div className={s.small}>{spots.foot}</div>
        </div>
      </section>

      <section className="boe-panel" aria-label={measures.title}>
        <Head title={measures.title} note={measures.note} />
        <div className={s.measures}>
          {measures.items.map(item => (
            <div key={item.label} className={s.measure}>
              <div className={s.measureLabel}>{item.label}</div>
              <div className={s.measureValue}>{item.value}</div>
              {item.lines.map(line => (
                <div key={line.label} className={s.measureLine}>
                  <span>{line.label}</span>
                  {line.value && <span className={line.direction ? `${s.change} ${line.direction === 'up' ? s.up : s.down}` : undefined}>{line.direction === 'up' ? '▲ ' : line.direction === 'down' ? '▼ ' : ''}{line.value}</span>}
                </div>
              ))}
              <div className={s.source}>{item.source}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="boe-panel" aria-label={ai.title}>
        <Head title={ai.title} note={ai.note} />
        <div className={s.ai}>
          {ai.items.map(item => (
            <div key={item.title} className={s.aiRow}>
              <div><div className={s.strong}>{item.title}</div><div className={s.small}>{item.text}</div></div>
              <Tag tag={item.tag} />
            </div>
          ))}
        </div>
      </section>

      <section className="boe-panel" aria-label={gaps.title}>
        <Head title={gaps.title} note={gaps.note} />
        <PhoneTableCards className={s.tableWrap}>
          <table className={`${s.table} ${s.gaps}`}>
            <thead><tr>{gaps.head.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{gaps.rows.map(row => <tr key={row[0]}>{row.map((cell, i) => <td key={`${i}-${cell}`} data-label={gaps.head[i]}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </PhoneTableCards>
      </section>

      <p className={s.foot}>{review.foot} <Link href="/seo/year">See the last 12 months</Link></p>
    </div>
  )
}

export function SeoSixMonth() {
  return (
    <SeoScreen title="6-month review" subtitle="The last 6 full months, against the 6 before and the same months last year">
      {data => data.sixMonth ? <ReviewBody review={data.sixMonth.body} /> : (
        <div className="boe-empty">
          <p className="boe-empty-title">No 6-month review yet</p>
          <p>It appears here after the scheduled sessions send the first one.</p>
        </div>
      )}
    </SeoScreen>
  )
}
