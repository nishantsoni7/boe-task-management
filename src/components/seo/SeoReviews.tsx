'use client'

import { useSeoAccess, useSeoWrites } from '@/hooks/useSeoAccess'
import {
  VERDICT_LABEL, answeredProposals, dayLabel, openProposals, reviewPage, reviewsNewestFirst, type SeoData, type SeoReview,
} from '@/lib/seo/report'
import { ProposalCard, type OnDecide } from './ProposalCard'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const BADGE = { on_track: 'completed', watch: 'waiting', off_track: 'blocked', none: 'pending' } as const

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div className={s.tight}>
      <h3 className={s.subheading}>{title}</h3>
      <ul className={s.list}>{items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  )
}

function ReviewPage({ review }: { review: SeoReview }) {
  const page = reviewPage(review)
  return (
    <section className={`boe-panel ${s.panel}`}>
      <div className={s.row}>
        <h2 className={s.heading}>Week of {dayLabel(review.review_date)}</h2>
        <span className={`boe-badge boe-badge-${BADGE[review.verdict]}`}>{VERDICT_LABEL[review.verdict]}</span>
      </div>
      {review.items_due !== null && review.numbers_on_target !== null && (
        <p className={s.note}>{review.items_done ?? 0} of {review.items_due} due items done, {review.numbers_on_target} of 5 numbers on target{page.direction ? `. ${page.direction} than last week` : ''}</p>
      )}
      {review.summary && <p className={s.text}>{review.summary}</p>}
      {page.numbers.length > 0 && (
        <div className={`boe-table-wrap ${s.tableScroll}`}>
          <table className="boe-table">
            <thead><tr><th>Number</th><th className="num">This week</th><th className="num">Last week</th><th className="num">Target</th><th>Note</th></tr></thead>
            <tbody>
              {page.numbers.map(n => (
                <tr key={n.measure}>
                  <td>{n.measure}</td>
                  <td className="num">{n.thisWeek}</td>
                  <td className="num">{n.lastWeek}</td>
                  <td className="num">{n.target}</td>
                  <td>{n.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={s.columns}>
        <Bullets title="Done" items={page.done} />
        <Bullets title="Pending" items={page.pending} />
        <Bullets title="Shipped" items={page.shipped} />
        <Bullets title="Needs your OK" items={page.needsOk} />
        <Bullets title="Competitors that moved" items={page.competitors} />
        <Bullets title="Next week" items={page.nextTasks} />
      </div>
      {page.biggestMove && <p className={s.text}><strong>Biggest move:</strong> {page.biggestMove}</p>}
      {page.risk && <p className={s.text}><strong>Risk:</strong> {page.risk}</p>}
    </section>
  )
}

export function ReviewsBody({ data, onDecide }: { data: SeoData; onDecide?: OnDecide }) {
  const open = openProposals(data)
  const answered = answeredProposals(data)
  const reviews = reviewsNewestFirst(data)
  return (
    <div className={s.stack}>
      {open.length > 0 && (
        <section className={s.tight}>
          <h2 className={s.heading}>Strategy changes waiting for an answer</h2>
          {open.map(p => <ProposalCard key={p.id} proposal={p} onDecide={onDecide} />)}
        </section>
      )}
      {reviews.length > 0
        ? reviews.map(review => <ReviewPage key={review.review_date} review={review} />)
        : <p className={s.note}>No Monday review yet. Each one appears here after the Monday session runs.</p>}
      {answered.length > 0 && (
        <section className={s.tight}>
          <h2 className={s.heading}>Strategy changes already answered</h2>
          {answered.map(p => <ProposalCard key={p.id} proposal={p} />)}
        </section>
      )}
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
