'use client'

// The Overview's content: who is doing well, who needs attention, and everyone's
// month at a glance. Presentation only. The numbers come from
// /api/attendance/overview and the rules are in src/lib/attendance/attendanceScore.ts.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ChevronRight } from 'lucide-react'
import { Badge, MONTH_NAMES, StatusFilter, ui, type Tone } from '@/components/attendancePayroll/ui'
import {
  OKAY_FROM, GREAT_FROM, sparkLine,
  type OverviewData, type OverviewPerson, type OverviewTotal, type ScoreBand, type StripDay, type StripDayKind,
} from '@/lib/attendance/attendanceScore'
import { todayLine, type TodayLine } from '@/lib/attendance/overviewToday'
import type { MachineDayView } from '@/lib/minop/machineDayView'
import styles from './overview.module.css'

type Filter = 'all' | ScoreBand | 'none'
type Sort = 'score' | 'late' | 'absent' | 'miss'

const BAND_TONE: Record<ScoreBand, Tone> = { great: 'good', okay: 'warn', attention: 'bad' }

const DAY_CLASS: Record<StripDayKind, string> = {
  ok:           styles.dOk,
  late:         styles.dLate,
  early:        styles.dLate,
  miss:         styles.dMiss,
  half:         styles.dHalf,
  absent:       styles.dAbsent,
  leave:        styles.dLeave,
  off:          styles.dOff,
  not_employed: styles.dOff,
  pending:      styles.dPending,
  unknown:      styles.dUnknown,
}

const DAY_LABEL: Record<StripDayKind, string> = {
  ok:           'On time',
  late:         'Late',
  early:        'Left early',
  miss:         'One punch missing',
  half:         'Half day',
  absent:       'Absent',
  leave:        'Approved leave',
  off:          'Sunday or holiday',
  not_employed: 'Not employed',
  pending:      'Not in yet',
  unknown:      'No Machine ID',
}

/** The legend doubles as the scoring rule, so the two cannot be read apart. */
const LEGEND: ReadonlyArray<{ kind: StripDayKind; label: string; worth: string }> = [
  { kind: 'ok',     label: 'On time, full day',  worth: '1 point' },
  { kind: 'late',   label: 'Late or left early', worth: '¾' },
  { kind: 'miss',   label: 'One punch missing',  worth: '¾' },
  { kind: 'half',   label: 'Half day',           worth: '½' },
  { kind: 'absent', label: 'Absent',             worth: '0' },
  { kind: 'leave',  label: 'Approved leave',     worth: 'not counted' },
  { kind: 'off',    label: 'Sunday or holiday',  worth: 'not counted' },
]

const dayTip = ({ date, kind }: StripDay) => {
  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
  return `${label}: ${DAY_LABEL[kind]}`
}

const stripSummary = (p: OverviewPerson) => {
  if (p.notRanked) return p.notRanked
  const { ok, late, early, miss, half, absent, leave } = p.tally
  return `${ok} on time, ${late + early} late or left early, ${miss} missing punch, ${half} half day, ${absent} absent, ${leave} on approved leave`
}

const daysPath = (p: OverviewPerson, data: OverviewData) =>
  `/attendance/monthly-review/${p.id}?year=${data.year}&month=${data.month}`

function DayStrip({ person, days }: { person: OverviewPerson; days: number }) {
  return (
    <span
      className={styles.strip}
      style={{ gridTemplateColumns: `repeat(${days}, var(--day-w))` }}
      role="img"
      aria-label={stripSummary(person)}
    >
      {person.strip.map(day => <span key={day.date} className={`${styles.d} ${DAY_CLASS[day.kind]}`} title={dayTip(day)} />)}
    </span>
  )
}

function Spark({ values, width, height, low, high, label }: {
  values: Array<number | null>
  width: number
  height: number
  low: number
  high: number
  label?: string
}) {
  const { points, end } = sparkLine(values, width, height, low, high)
  if (!end) return null
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={styles.spark}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <polyline className={styles.sparkLine} points={points} />
      <circle className={styles.sparkDot} cx={end.x} cy={end.y} r={3.5} />
    </svg>
  )
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className={styles.flat}>—</span>
  const shown = value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0'
  return <span className={value > 0 ? styles.up : value < 0 ? styles.down : styles.flat}>{shown}</span>
}

function Tile({ label, total, children }: { label: string; total: OverviewTotal; children?: React.ReactNode }) {
  const who = total.people === 1 ? '1 person' : `${total.people} people`
  return (
    <section className={`${ui.surface} ${styles.tile}`} aria-label={label}>
      <p className={styles.tileLabel}>{label}</p>
      <span className={styles.tileValue}>{total.total}</span>
      <p className={styles.tileSub}>
        {total.top ? `${who}. Most: ${total.top.name}, ${total.top.count}` : 'Nobody this month'}
        {children}
      </p>
    </section>
  )
}

function PersonPanel({ title, sub, icon, people, empty, data, className }: {
  title: string
  sub: string
  icon: React.ReactNode
  people: OverviewPerson[]
  empty: string
  data: OverviewData
  className?: string
}) {
  return (
    <section className={`${ui.surface} ${className ?? ''}`} aria-label={title}>
      <div className={styles.panelHead}>
        {icon}
        <div>
          <h2 className={ui.surfaceTitle}>{title}</h2>
          <p className={ui.surfaceSub}>{sub}</p>
        </div>
      </div>
      {people.length === 0 && <p className={styles.panelEmpty}>{empty}</p>}
      {people.map(p => (
        <Link key={p.id} href={daysPath(p, data)} className={styles.personRow}>
          <span className={styles.personText}>
            <span className={styles.personName}>{p.name}</span>
            <span className={styles.personWhy}>{p.reason}</span>
          </span>
          <span className={styles.personScore}>{p.score}</span>
          <ChevronRight size={16} strokeWidth={1.8} className={styles.chev} aria-hidden="true" />
        </Link>
      ))}
    </section>
  )
}

function SortHeader({ label, value, sort, onSort }: {
  label: string
  value: Sort
  sort: Sort
  onSort: (next: Sort) => void
}) {
  const active = sort === value
  return (
    <th scope="col" className={ui.num} aria-sort={active ? 'descending' : undefined}>
      <button type="button" className={`${styles.sort} ${active ? styles.sortOn : ''}`} onClick={() => onSort(value)}>
        {label}
      </button>
    </th>
  )
}

function TodayBand({ line, data }: { line: TodayLine | null; data: OverviewData }) {
  const needsId = data.noMachineId === 1 ? '1 person has no Machine ID' : `${data.noMachineId} people have no Machine ID`
  const waiting = data.pendingRequests === 1 ? '1 request waiting' : `${data.pendingRequests} requests waiting`
  return (
    <section className={`${ui.surface} ${styles.band} ${line?.stopped ? styles.bandBad : ''}`} aria-label="Right now">
      <div className={styles.bandText}>
        {line && <span className={`${styles.dot} ${line.stopped ? styles.dotBad : ''}`} aria-hidden="true" />}
        <p>{line ? <><strong>{line.lead}</strong> {line.detail}</> : 'See who has punched on the Today page.'}</p>
      </div>
      <div className={styles.bandLinks}>
        {data.pendingRequests > 0 && <Link href="/attendance/requests" className={styles.chip}>{waiting}</Link>}
        {data.noMachineId > 0 && <Link href="/attendance/employees" className={styles.chip}>{needsId}</Link>}
        <Link href="/attendance/today" className={styles.chip}>Open Today</Link>
      </div>
    </section>
  )
}

const PAGE_LINKS: ReadonlyArray<{ title: string; links: ReadonlyArray<{ label: string; href: string }> }> = [
  {
    title: 'Each month',
    links: [
      { label: 'Upload',         href: '/attendance/upload' },
      { label: 'Records',        href: '/attendance/records' },
      { label: 'Monthly Review', href: '/attendance/monthly-review' },
      { label: 'Requests',       href: '/attendance/requests' },
      { label: 'Payroll',        href: '/payroll' },
    ],
  },
  {
    title: 'Keep an eye on',
    links: [
      { label: 'Today',           href: '/attendance/today' },
      { label: 'Attendance Sync', href: '/attendance/minop' },
      // Nothing in the sidebar reaches this page, so this link has to stay.
      { label: 'Correction Log',  href: '/attendance/correction-log' },
    ],
  },
  {
    title: 'Set up',
    links: [
      { label: 'Employees',     href: '/attendance/employees' },
      { label: 'Holidays',      href: '/attendance/holidays' },
      { label: 'Payroll Rules', href: '/payroll/settings' },
    ],
  },
]

export function PageLinks() {
  return (
    <section className={`${ui.surface} ${styles.links}`} aria-label="All attendance pages">
      {PAGE_LINKS.map(group => (
        <div key={group.title}>
          <p className={styles.linksTitle}>{group.title}</p>
          <div className={styles.linksRow}>
            {group.links.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </div>
        </div>
      ))}
    </section>
  )
}

export function OverviewBoard({ data, today }: { data: OverviewData; today: MachineDayView | null }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('score')

  const ranked = useMemo(() => data.people.filter(p => p.score !== null), [data])
  const unranked = useMemo(() => data.people.filter(p => p.score === null), [data])

  const great = useMemo(() => ranked.filter(p => p.band === 'great'), [ranked])
  const attention = useMemo(() => ranked.filter(p => p.band === 'attention').reverse(), [ranked])

  const rows = useMemo(() => {
    const worth = (p: OverviewPerson) => {
      if (sort === 'late') return p.tally.late + p.tally.early
      if (sort === 'absent') return p.tally.absent
      if (sort === 'miss') return p.tally.miss
      return p.score ?? 0
    }
    const ordered = [...ranked].sort((a, b) => worth(b) - worth(a) || (a.rank ?? 0) - (b.rank ?? 0))
    if (filter === 'all') return [...ordered, ...unranked]
    return filter === 'none' ? unranked : ordered.filter(p => p.band === filter)
  }, [ranked, unranked, sort, filter])

  const filters = [
    { key: 'all' as const,       label: 'All',             count: data.people.length },
    { key: 'great' as const,     label: 'Great',           count: great.length },
    { key: 'okay' as const,      label: 'Okay',            count: ranked.length - great.length - attention.length },
    { key: 'attention' as const, label: 'Needs attention', count: attention.length },
    { key: 'none' as const,      label: 'Not ranked',      count: unranked.length },
  ]

  const days = data.people[0]?.strip.length ?? 0
  const previous = MONTH_NAMES[data.months[data.months.length - 2].month - 1]
  const deltaText = data.company.delta === null ? 'No month before to compare'
    : data.company.delta === 0 ? `Same as ${previous}`
    : `${Math.abs(data.company.delta)} point${Math.abs(data.company.delta) === 1 ? '' : 's'} ${data.company.delta < 0 ? 'below' : 'above'} ${previous}`
  const line = today ? todayLine(today) : null
  const decisions = `/attendance/monthly-review?view=decisions&year=${data.year}&month=${data.month}`

  return (
    <div className={ui.stack}>
      <TodayBand line={line} data={data} />

      <div className={styles.tiles}>
        <section className={`${ui.surface} ${styles.tile}`} aria-label="Company score">
          <p className={styles.tileLabel}>Company score</p>
          <div className={styles.tileMain}>
            <span className={`${styles.tileValue} ${styles.tileHero}`}>{data.company.score ?? '—'}</span>
            <Spark values={data.company.history} width={132} height={44} low={60} high={100} label="Company score over the last six months" />
          </div>
          <p className={styles.tileSub}>{deltaText}</p>
        </section>
        <Tile label="Late or left early" total={data.totals.late} />
        <Tile label="Absent days" total={data.totals.absent} />
        <Tile label="Missing punches" total={data.totals.miss}>
          {data.totals.miss.total > 0 && <>. <Link href={decisions} className={ui.link}>Review them</Link></>}
        </Tile>
      </div>

      <div className={styles.panels}>
        <PersonPanel
          title="Doing great"
          sub={`Scored ${GREAT_FROM} or more this month, best first`}
          icon={<span className={`${styles.mark} ${styles.markGood}`}><Check size={17} strokeWidth={2} aria-hidden="true" /></span>}
          people={great}
          empty={`Nobody reached ${GREAT_FROM} this month.`}
          data={data}
          className={styles.greatPanel}
        />
        <PersonPanel
          title="Needs attention"
          sub={`Scored below ${OKAY_FROM} this month, lowest first`}
          icon={<span className={`${styles.mark} ${styles.markBad}`}><AlertTriangle size={17} strokeWidth={2} aria-hidden="true" /></span>}
          people={attention}
          empty={`Nobody is below ${OKAY_FROM} this month.`}
          data={data}
        />
      </div>

      <section className={ui.surface} aria-label="Everyone this month">
        <div className={ui.surfaceHead}>
          <div>
            <h2 className={ui.surfaceTitle}>Everyone this month</h2>
            <p className={ui.surfaceSub}>One block per day. Open a name to see that person’s days.</p>
          </div>
          <StatusFilter label="Filter people by score" value={filter} options={filters} onChange={setFilter} />
        </div>

        <div className={styles.legend}>
          {LEGEND.map(item => (
            <span key={item.kind} className={styles.legendItem}>
              <span className={`${styles.d} ${DAY_CLASS[item.kind]}`} aria-hidden="true" />
              {item.label} <b>{item.worth}</b>
            </span>
          ))}
          <p className={styles.legendNote}>
            Score = points earned ÷ days counted × 100. A day you waived or approved never counts against the person.
          </p>
        </div>

        <div className={`${ui.tableWrap} ${ui.desktopOnly}`}>
          <table className={`${ui.table} ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col" className={ui.num}>#</th>
                <th scope="col">Employee</th>
                <SortHeader label="Score" value="score" sort={sort} onSort={setSort} />
                <th scope="col">Days of the month</th>
                <SortHeader label="Late or early" value="late" sort={sort} onSort={setSort} />
                <SortHeader label="Absent" value="absent" sort={sort} onSort={setSort} />
                <SortHeader label="Missing punch" value="miss" sort={sort} onSort={setSort} />
                <th scope="col" className={ui.num}>Usual arrival</th>
                <th scope="col" className={ui.num}>Last 6 months</th>
                <th scope="col"><span className={ui.srOnly}>Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const ranks = p.score !== null
                return (
                  <tr key={p.id}>
                    <td className={`${ui.num} ${ui.muted}`}>{p.rank ?? '—'}</td>
                    <td>
                      <Link href={daysPath(p, data)} className={styles.name}>{p.name}</Link>
                      <div className={ui.sub}>{p.notRanked ?? p.code}</div>
                    </td>
                    <td className={ui.num}>
                      {p.band ? <Badge tone={BAND_TONE[p.band]}>{p.score}</Badge> : <Badge tone="neutral">—</Badge>}
                    </td>
                    <td><DayStrip person={p} days={days} /></td>
                    <td className={ui.num}>{ranks ? p.tally.late + p.tally.early : '—'}</td>
                    <td className={`${ui.num} ${ranks && p.tally.absent > 0 ? styles.bad : ''}`}>{ranks ? p.tally.absent : '—'}</td>
                    <td className={`${ui.num} ${ranks && p.tally.miss > 0 ? styles.warn : ''}`}>{ranks ? p.tally.miss : '—'}</td>
                    <td className={ui.num}>{p.usualArrival ?? '—'}</td>
                    <td>
                      <span className={styles.trend}>
                        <Spark values={p.history} width={64} height={26} low={60} high={100} />
                        <Delta value={p.delta} />
                      </span>
                    </td>
                    <td>
                      <Link href={daysPath(p, data)} className={styles.go} aria-label={`Open ${p.name}’s days`}>
                        <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <ul className={`${ui.cards} ${styles.phoneCards}`}>
          {rows.map(p => (
            <li key={p.id} className={styles.phoneCard}>
              <div className={ui.cardHead}>
                <Link href={daysPath(p, data)} className={styles.name}>
                  {p.rank && <span className={styles.phoneRank}>{p.rank}</span>}{p.name}
                </Link>
                {p.band ? <Badge tone={BAND_TONE[p.band]}>{p.score}</Badge> : <Badge tone="neutral">—</Badge>}
              </div>
              <DayStrip person={p} days={days} />
              <p className={styles.phoneLine}>
                {p.notRanked ?? `${p.tally.late + p.tally.early} late or early, ${p.tally.absent} absent, ${p.tally.miss} missing punch.${p.usualArrival ? ` Usually in at ${p.usualArrival}.` : ''}`}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <PageLinks />
    </div>
  )
}
