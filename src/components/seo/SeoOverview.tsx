'use client'

import { AppLink as Link } from '@/components/ui/AppLink'
import { istToday } from '@/lib/istDate'
import { monthClicks, needsYou, pageNotes, percentChange, thousands, weekNumbers, type SideNumber } from '@/lib/seo/pages'
import {
  VERDICT_LABEL, dayLabel, formatCount, latestReview, reviewPage, targets, taskStates,
  type SeoData, type TaskState,
} from '@/lib/seo/report'
import type { SeoTag } from '@/lib/seo/sixMonth'
import { Check, Foot, Hero, Rows } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const TASK_TAG: Record<TaskState['state'], SeoTag> = {
  never: { text: 'No run yet', tone: 'pending' },
  ok: { text: 'Fine', tone: 'good' },
  late: { text: 'Late', tone: 'wait' },
  retry: { text: 'No action', tone: 'wait' },
  problem: { text: 'Needs you', tone: 'bad' },
}

const moved = (now: number, before: number | null): SideNumber['tone'] => (before === null || now === before ? undefined : now > before ? 'up' : 'down')

export function OverviewBody({ data, today }: { data: SeoData; today: string }) {
  const notes = pageNotes(data, 'overview')
  const review = latestReview(data)
  const page = review ? reviewPage(review) : null
  const week = weekNumbers(data)
  const month = monthClicks(data)
  const numbers = targets(data, today)
  const needs = needsYou(data, notes)
  const daily = week?.daily ?? []
  const peak = Math.max(...daily.map(d => d.clicks), 1)
  const half = Math.floor(daily.length / 2)

  const side: SideNumber[] = []
  if (week) side.push({ label: 'Clicks', note: `${formatCount(week.clicks)} against ${formatCount(week.previous ?? 0)}, all countries`, value: percentChange(week.clicks, week.previous), tone: moved(week.clicks, week.previous) })
  if (week?.views) side.push({ label: 'Times shown', note: `${thousands(week.views)} against ${thousands(week.viewsPrevious ?? 0)}`, value: percentChange(week.views, week.viewsPrevious), tone: moved(week.views, week.viewsPrevious) })
  if (month) side.push({ label: 'Clicks over 28 days', note: `${formatCount(month.clicks)} against ${formatCount(month.previous ?? 0)}`, value: percentChange(month.clicks, month.previous), tone: moved(month.clicks, month.previous) })

  return (
    <div className={s.page}>
      <Hero
        notes={notes}
        side={side}
        sideTitle="On the week before"
        fallback={review
          ? { title: VERDICT_LABEL[review.verdict], text: `${review.items_done ?? 0} of ${review.items_due ?? 0} due items done, ${review.numbers_on_target ?? 0} of 5 numbers on target. ${review.summary}` }
          : { title: 'No Monday review yet', text: 'The first verdict with items due comes on Monday 9 Nov.' }}
      />

      <section className="boe-panel" aria-label="Needs you">
        <Head title="Needs you" note="In date order" />
        {needs.length === 0 && <div className={s.mini}><span>Nothing is waiting on you.</span></div>}
        {needs.map(need => (
          <div key={need.title} className={`${s.need}${need.urgent ? ` ${s.needNow}` : ''}`}>
            <span className={s.when}>{need.when}</span>
            <div><div className={s.strong}>{need.title}</div>{need.why && <div className={s.small}>{need.why}</div>}</div>
            {need.href && (need.href.startsWith('/')
              ? <Link className="boe-btn boe-btn-secondary" href={need.href}>{need.action}</Link>
              : <a className="boe-btn boe-btn-primary" href={need.href} target="_blank" rel="noreferrer">{need.action}</a>)}
          </div>
        ))}
      </section>

      {numbers.length > 0 && (
        <section className="boe-panel" aria-label="The five numbers">
          <Head title="The five numbers" note="The line on each bar is this month's target" />
          <div className={`${s.numberRow} ${s.rowHead}`}><span>Number</span><span className={s.right}>Now</span><span>Towards April</span><span className={s.right}>Nov / April</span><span>State</span></div>
          {numbers.map(n => {
            const april = n.april ?? 0
            return (
              <div key={n.measure} className={s.numberRow}>
                <span className={s.strong}>{n.label}</span>
                <span className={s.numberNow}>{n.now === null ? '—' : formatCount(n.now)}</span>
                <div className={s.targetTrack}>
                  <i style={{ width: `${april && n.now !== null ? Math.min((n.now / april) * 100, 100) : 0}%` }} />
                  {april > 0 && n.target !== null && <b style={{ left: `${Math.min((n.target / april) * 100, 100)}%` }} />}
                </div>
                <span className={s.targetText}>{n.target === null ? '—' : formatCount(n.target)} / {april ? formatCount(april) : '—'}</span>
                <Tag tag={n.state} className={s.selfStart} />
              </div>
            )
          })}
          <Check text={notes.checks.numbers} />
        </section>
      )}

      {(daily.length > 0 || page?.biggestMove || page?.risk || notes.rows.length > 0) && (
        <section className={s.two} aria-label="This week">
          {daily.length > 0 && (
            <div className="boe-panel">
              <Head title="Clicks each day" note={`${dayLabel(daily[0].date)} to ${dayLabel(daily[daily.length - 1].date)}, all countries`} />
              <div className={s.days} role="img" aria-label={`Daily clicks from ${daily[0].clicks} on ${dayLabel(daily[0].date)} to ${daily[daily.length - 1].clicks} on ${dayLabel(daily[daily.length - 1].date)}.`}>
                {daily.map((day, index) => <i key={day.date} className={index >= half ? s.dayRecent : undefined} style={{ height: `${Math.round((day.clicks / peak) * 100)}%` }} title={`${dayLabel(day.date)}: ${day.clicks}`} />)}
              </div>
              <div className={s.dayAxis}><span>{dayLabel(daily[0].date)}</span><span>{dayLabel(daily[half].date)}</span><span>{dayLabel(daily[daily.length - 1].date)}</span></div>
            </div>
          )}
          <div className="boe-panel">
            <Head title="What moved this week" />
            {page?.biggestMove && <div className={s.mini}><span><b>Biggest move:</b> {page.biggestMove}</span>{page.moveTag && <Tag tag={page.moveTag} />}</div>}
            {page?.risk && <div className={s.mini}><span><b>Main risk:</b> {page.risk}</span>{page.riskTag && <Tag tag={page.riskTag} />}</div>}
            <Rows items={notes.rows} />
          </div>
        </section>
      )}

      <section className="boe-panel" aria-label="Are the figures fresh?">
        <Head title="Are the figures fresh?" note="Open Scheduled tasks for detail" />
        <div className={s.taskCards}>
          {taskStates(data, today).map(task => (
            <div key={task.label} className={s.taskCard}>
              <span className={s.strong}>{task.label}</span>
              <span className={s.small}>{task.text}</span>
              <Tag tag={TASK_TAG[task.state]} className={s.selfStart} />
            </div>
          ))}
        </div>
      </section>

      <section className="boe-panel" aria-label="The bigger picture">
        <div className={s.linkCard}>
          <div><div className={s.strong}>The bigger picture</div>{notes.link && <div className={s.small}>{notes.link}</div>}</div>
          <Link className="boe-btn boe-btn-secondary" href="/seo/review">Open the 6-month review</Link>
        </div>
      </section>

      <Foot text={notes.foot} />
    </div>
  )
}

export function SeoOverview() {
  return (
    <SeoScreen title="SEO" subtitle="Are we winning more hotel and restaurant projects from Google?">
      {data => <OverviewBody data={data} today={istToday()} />}
    </SeoScreen>
  )
}
