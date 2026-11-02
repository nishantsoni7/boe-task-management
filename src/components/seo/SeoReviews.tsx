'use client'

import { useSeoAccess, useSeoWrites } from '@/hooks/useSeoAccess'
import { monthClicks, pageNotes, percentChange, type SideNumber } from '@/lib/seo/pages'
import {
  VERDICT_LABEL, answeredProposals, dayLabel, openProposals, reviewPage, reviewsNewestFirst, type SeoData, type SeoReview,
} from '@/lib/seo/report'
import type { SeoTone } from '@/lib/seo/sixMonth'
import { ProposalCard, type OnDecide } from './ProposalCard'
import { Check, Foot, Hero, Rows } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const TONE: Record<SeoReview['verdict'], SeoTone> = { on_track: 'good', watch: 'wait', off_track: 'bad', none: 'pending' }

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div className={s.listColumn}>
      <div className={s.strong}>{title}</div>
      <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  )
}

export function ReviewsBody({ data, onDecide }: { data: SeoData; onDecide?: OnDecide }) {
  const reviews = reviewsNewestFirst(data)
  const open = openProposals(data)
  const answered = answeredProposals(data)
  const review = reviews[0]
  if (!review) return <p className={s.small}>No Monday review yet. Each one appears here after the Monday session runs.</p>

  const notes = pageNotes(data, 'weekly')
  const page = reviewPage(review)
  const month = monthClicks(data)
  const side: SideNumber[] = []
  if (review.items_due !== null) side.push({ label: 'Items due and done', note: notes.checks.items ?? '', value: `${review.items_done ?? 0} of ${review.items_due}` })
  if (review.numbers_on_target !== null) side.push({ label: 'Numbers on target', note: notes.checks.on_target ?? '', value: `${review.numbers_on_target} of 5` })
  if (month) side.push({ label: 'Clicks over 28 days', note: notes.checks.rule ?? '', value: percentChange(month.clicks, month.previous), tone: month.previous !== null && month.clicks < month.previous ? 'down' : undefined })

  return (
    <div className={s.page}>
      <Hero
        notes={notes}
        sideTitle="This week"
        side={[...side, ...notes.side]}
        fallback={{ title: `Week of ${dayLabel(review.review_date)}: ${VERDICT_LABEL[review.verdict]}`, text: `${page.direction ? `${page.direction} than last week. ` : ''}${review.summary}` }}
      />

      {page.numbers.length > 0 && (
        <section className="boe-panel" aria-label="The five numbers">
          <Head title="The five numbers" note="This week, last week and the target" />
          <div className={`${s.weekRow} ${s.rowHead}`}><span>Number</span><span>This week</span><span>Last week</span><span>Target</span><span className={s.weekNote}>Note</span></div>
          {page.numbers.map(n => (
            <div key={n.measure} className={s.weekRow}>
              <span className={s.strong}>{n.measure}</span>
              <span>{n.thisWeek}</span>
              <span className={s.small}>{n.lastWeek}</span>
              <span className={s.small}>{n.target}</span>
              <span className={`${s.small} ${s.weekNote}`}>{n.tag && <Tag tag={n.tag} />} {n.note}</span>
            </div>
          ))}
          <Check text={notes.checks.numbers} />
        </section>
      )}

      {(page.done.length > 0 || page.pending.length > 0 || page.nextTasks.length > 0) && (
        <section className="boe-panel" aria-label="The week's work">
          <Head title="The week's work" note={notes.checks.ai} />
          <div className={s.lists}>
            <List title="Done" items={page.done} />
            <List title="Pending" items={page.pending} />
            <List title="Next week" items={page.nextTasks} />
          </div>
        </section>
      )}

      {(page.biggestMove || page.risk) && (
        <section className={s.two} aria-label="Move and risk">
          {page.biggestMove && <div className="boe-panel"><Head title="Biggest move" /><div className={s.mini}><span>{page.biggestMove}</span>{page.moveTag && <Tag tag={page.moveTag} />}</div></div>}
          {page.risk && <div className="boe-panel"><Head title="Biggest risk" /><div className={s.mini}><span>{page.risk}</span>{page.riskTag && <Tag tag={page.riskTag} />}</div></div>}
        </section>
      )}

      {(notes.rows.length > 0 || page.competitors.length > 0) && (
        <section className="boe-panel" aria-label="Competitors">
          <Head title="Competitors" note="What moved this week" />
          {notes.rows.length > 0 ? <Rows items={notes.rows} /> : page.competitors.map(line => <div key={line} className={s.mini}><span>{line}</span></div>)}
        </section>
      )}

      {open.length > 0 && (
        <section className="boe-panel" aria-label="Strategy changes waiting for an answer">
          <Head title="Strategy changes waiting for an answer" note="Your decision. The recommendation is ours." />
          {open.map(p => <ProposalCard key={p.id} proposal={p} onDecide={onDecide} />)}
        </section>
      )}

      {answered.length > 0 && (
        <section className="boe-panel" aria-label="Strategy changes already answered">
          <Head title="Strategy changes already answered" />
          {answered.map(p => <ProposalCard key={p.id} proposal={p} />)}
        </section>
      )}

      <section className="boe-panel" aria-label="Past weeks">
        <Head title="Past weeks" note="One row a Monday, newest first" />
        {reviews.map(week => (
          <div key={week.review_date} className={s.mini}>
            <span><b>Week of {dayLabel(week.review_date)}:</b> {week.items_done ?? 0} of {week.items_due ?? 0} items done{week !== review && week.summary ? `. ${week.summary}` : ''}</span>
            <Tag tag={{ text: VERDICT_LABEL[week.verdict], tone: TONE[week.verdict] }} />
          </div>
        ))}
      </section>

      <Foot text={notes.foot} />
    </div>
  )
}

export function SeoReviews() {
  const { canDecide } = useSeoAccess()
  const { decide } = useSeoWrites()
  return (
    <SeoScreen title="Weekly review" subtitle="Every Monday: are we on track, and do we change anything?">
      {data => <ReviewsBody data={data} onDecide={canDecide ? decide : undefined} />}
    </SeoScreen>
  )
}
