'use client'

import { ChevronRight } from 'lucide-react'
import type { Task } from '@/lib/types'
import type { CreationReport } from '@/lib/tasks/taskReporting'
import { TaskCreationReportCard } from '@/components/tasks/TaskCreationReport'
import styles from './glanceBar.module.css'

// The Dashboard's "At a glance" bar: the three counters (Overdue, Waiting,
// Due Today) and Tasks Created, moved out of the bottom of the page into a
// bar on the right, built like the Modules page's "For you" panel. Same
// counts, same labels, same rule: a counter opens its list only when it has
// one. The page computes every list; this holds no task logic.
export function GlanceBar({
  overdueTasks,
  waitingTasks,
  dueTodayTasks,
  creationReport,
  onShowList,
}: {
  overdueTasks: Task[]
  waitingTasks: Task[]
  dueTodayTasks: Task[]
  creationReport: CreationReport | undefined
  onShowList: (list: { title: string; items: Task[] }) => void
}) {
  const counters = [
    { label: 'Overdue',   sub: 'Needs attention', items: overdueTasks,  title: 'Overdue Tasks', alarm: true },
    { label: 'Waiting',   sub: 'Pending action',  items: waitingTasks,  title: 'Waiting Tasks', alarm: false },
    { label: 'Due Today', sub: 'Finish today',    items: dueTodayTasks, title: 'Due Today',     alarm: false },
  ]

  return (
    <aside className={styles.glance} aria-labelledby="dashboard-glance-heading">
      <div className={styles.head}>
        <h2 id="dashboard-glance-heading" className={styles.heading}>At a glance</h2>
      </div>

      <section className={styles.group} aria-labelledby="dashboard-glance-now">
        <h3 id="dashboard-glance-now" className={styles.groupLabel}>Your tasks now</h3>
        <ul className={styles.counters}>
          {counters.map(item => {
            const count = item.items.length
            const countClass = count === 0 ? styles.countZero : item.alarm ? styles.countAlarm : ''
            const body = (
              <>
                <span className={`${styles.count} ${countClass}`}>{count}</span>
                <span className={styles.counterText}>
                  <span className={styles.counterLabel}>{item.label}</span>
                  <span className={styles.counterSub}>{item.sub}</span>
                </span>
              </>
            )
            return (
              <li key={item.label}>
                {count > 0 ? (
                  <button
                    type="button"
                    className={styles.counter}
                    onClick={() => onShowList({ title: item.title, items: item.items })}
                  >
                    {body}
                    <span className={styles.chevron} aria-hidden="true">
                      <ChevronRight size={14} strokeWidth={2} />
                    </span>
                  </button>
                ) : (
                  <div className={styles.counter}>{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className={styles.group} aria-labelledby="dashboard-glance-created">
        <h3 id="dashboard-glance-created" className={styles.groupLabel}>
          Tasks created
          <span className={styles.groupHint}>Rolling, up to now</span>
        </h3>
        <TaskCreationReportCard report={creationReport} />
      </section>
    </aside>
  )
}
