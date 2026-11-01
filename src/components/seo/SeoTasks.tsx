'use client'

import { istToday } from '@/lib/istDate'
import { RUN_LABEL, dayLabel, taskHistories, type SeoData, type TaskState } from '@/lib/seo/report'
import { SeoScreen } from './SeoScreen'
import s from './seo.module.css'

const BADGE: Record<TaskState['state'], string> = { never: 'pending', ok: 'completed', late: 'waiting', problem: 'blocked' }

export function TasksBody({ data, today }: { data: SeoData; today: string }) {
  return (
    <div className={s.board}>
      {taskHistories(data, today).map(task => (
        <section key={task.label} className={`boe-panel ${s.panel}`}>
          <div className={s.row}>
            <h2 className={s.heading}>{task.label}</h2>
            <span className={`boe-badge boe-badge-${BADGE[task.state]}`}>{task.text}</span>
          </div>
          <p className={s.note}>{task.schedule}</p>
          {task.advice && <p className={s.text}>{task.advice}</p>}
          {task.recent.map(run => (
            <div key={run.run_date} className={s.row}>
              <span>{dayLabel(run.run_date)}{run.message ? ` · ${run.message}` : ''}</span>
              <span className={s.note}>{RUN_LABEL[run.status]}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

export function SeoTasks() {
  return (
    <SeoScreen title="Scheduled tasks" subtitle="Did each task run, and is any figure out of date?">
      {data => <TasksBody data={data} today={istToday()} />}
    </SeoScreen>
  )
}
