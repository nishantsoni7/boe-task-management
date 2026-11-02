'use client'

import { istToday } from '@/lib/istDate'
import { CELL_LABEL, pageNotes, sourceAges, taskGrid, type TaskCell } from '@/lib/seo/pages'
import { dayLabel, taskHistories, type SeoData } from '@/lib/seo/report'
import { Check, Foot, Hero, Rows } from './seoParts'
import { SeoScreen } from './SeoScreen'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const CELL_CLASS: Record<TaskCell, string> = { ran: s.cellOk, saved: s.cellOk, stopped: s.cellBad, login: s.cellWait, due: s.cellNone, none: s.cellNone }
const RUN_TIMES = [
  { label: 'City check', note: 'Needs the PC on', value: '3:44 pm' },
  { label: 'Nightly backup', note: 'Needs the PC on', value: '9:30 pm' },
  { label: 'Ahrefs research', note: 'Needs the Toolsurf login', value: '9:52 pm' },
]

export function TasksBody({ data, today }: { data: SeoData; today: string }) {
  const notes = pageNotes(data, 'tasks')
  const grid = taskGrid(data, today)
  const sources = sourceAges(data, today)

  return (
    <div className={s.page}>
      <Hero notes={notes} sideTitle="Run times each day" side={RUN_TIMES} fallback={{ title: 'Did each task run?' }} />

      <section className="boe-panel" aria-label="The last 7 days">
        <Head title="The last 7 days" note="One square a day" />
        <div className={`${s.taskRow} ${s.taskHead} ${s.rowHead}`}>
          <span>Task</span>
          {grid.days.map(day => <span key={day} className={s.center}>{dayLabel(day)}</span>)}
          <span className={s.taskNote}>What to do</span>
        </div>
        {taskHistories(data, today).map(task => (
          <div key={task.label} className={s.taskRow}>
            <span><span className={s.strong}>{task.label}</span><br /><span className={s.small}>{task.schedule}</span></span>
            {grid.cells(task.feed).map((cell, index) => <span key={grid.days[index]} className={`${s.cell} ${CELL_CLASS[cell]}`}>{CELL_LABEL[cell]}</span>)}
            <span className={`${s.small} ${s.taskNote}`}>{task.advice ?? notes.checks[task.feed] ?? task.text}</span>
          </div>
        ))}
        <div className={s.legend}><span>Ran: finished and sent</span><span>Saved: ran only after you logged in</span><span>Stop: Google stopped it</span><span>Login: Toolsurf logged out</span><span>Due: later today</span><span>Dash: nothing due</span></div>
      </section>

      {sources.length > 0 && (
        <section className="boe-panel" aria-label="How old is each figure?">
          <Head title="How old is each figure?" note="Anything older than 7 days is marked" />
          {sources.map(source => (
            <div key={source.name} className={s.mini}>
              <span><b>{source.name}:</b> {source.when}{source.note && <><br /><span className={s.small}>{source.note}</span></>}</span>
              <Tag tag={source.tag} />
            </div>
          ))}
          <Check text={notes.checks.sources} />
        </section>
      )}

      {notes.rows.length > 0 && (
        <section className="boe-panel" aria-label="What can stop a task">
          <Head title="What can stop a task" note="And what to do" />
          <Rows items={notes.rows} />
        </section>
      )}

      <Foot text={notes.foot} />
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
