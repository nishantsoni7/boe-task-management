'use client'

import { istToday } from '@/lib/istDate'
import {
  VERDICT_LABEL, dayLabel, formatCount, latestReview, needsOwner, openProposals, taskStates, targets,
  type SeoData, type TaskState,
} from '@/lib/seo/report'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const VERDICT_BADGE = { on_track: 'completed', watch: 'waiting', off_track: 'blocked', none: 'pending' } as const
const TASK_BADGE: Record<TaskState['state'], string> = { never: 'pending', ok: 'completed', late: 'waiting', problem: 'blocked' }

export function OverviewBody({ data, today }: { data: SeoData; today: string }) {
  const review = latestReview(data)
  const numbers = targets(data, today)
  const items = needsOwner(data)
  const proposals = openProposals(data)
  const tasks = taskStates(data, today)

  return (
    <div className={s.stack}>
      <div className={`boe-panel ${s.verdict}`}>
        {review ? (
          <>
            <span className={`boe-badge boe-badge-${VERDICT_BADGE[review.verdict]}`}>{dayLabel(review.review_date)}</span>
            <span className={s.verdictWord}>{VERDICT_LABEL[review.verdict]}</span>
            {review.items_due !== null && review.numbers_on_target !== null && (
              <span>{review.items_done ?? 0} of {review.items_due} due items done, {review.numbers_on_target} of 5 numbers on target</span>
            )}
          </>
        ) : (
          <span>No Monday review yet. The first verdict with items due comes on Monday 9 Nov.</span>
        )}
      </div>

      {review?.summary && <p className={s.text}>{review.summary}</p>}

      {numbers.length > 0 && (
        <div className={s.stats}>
          {numbers.map(n => (
            <div key={n.measure} className={`boe-panel ${s.stat}`}>
              <span className={s.statValue}>{n.now === null ? '—' : formatCount(n.now)}</span>
              <span className={s.statLabel}>{n.measure}</span>
              <span className={s.note}>{n.target === null ? 'No target set' : `This month's target ${formatCount(n.target)}`}</span>
            </div>
          ))}
        </div>
      )}

      <div className={s.columns}>
        <section className={`boe-panel ${s.panel}`}>
          <h2 className={s.heading}>Needs your OK</h2>
          {items.length === 0 && proposals.length === 0 && <p className={s.note}>Nothing is waiting on you.</p>}
          {items.map(item => (
            <div key={item.id} className={s.row}>
              <span>{item.title}</span>
              {item.due_date && <span className={s.note}>{dayLabel(item.due_date)}</span>}
            </div>
          ))}
          {proposals.map(p => (
            <div key={p.id} className={s.row}>
              <span>{p.title}</span>
              <span className="boe-badge boe-badge-waiting">Keep or change</span>
            </div>
          ))}
        </section>

        <section className={`boe-panel ${s.panel}`}>
          <h2 className={s.heading}>Scheduled tasks</h2>
          {tasks.map(task => (
            <div key={task.label} className={s.row}>
              <span>{task.label}</span>
              <span className={`boe-badge boe-badge-${TASK_BADGE[task.state]}`}>{task.text}</span>
            </div>
          ))}
        </section>
      </div>
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
