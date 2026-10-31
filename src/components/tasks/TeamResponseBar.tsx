'use client'

import { useState } from 'react'
import { Activity, ChevronDown, CircleAlert, CircleCheck, Clock, type LucideIcon } from 'lucide-react'
import {
  formatStripDay, personSummary, STRIP_WORKING_DAYS, talkingPoints, teamSummaryLine,
  type DayState, type PersonResponse, type ResponseLabel, type TeamResponse,
} from '@/lib/tasks/teamResponse'
import styles from './teamResponseBar.module.css'

const LABELS: Record<ResponseLabel, { text: string; Icon: LucideIcon; className: string }> = {
  least_active: { text: 'Least active', Icon: CircleAlert, className: styles.tagLow },
  inconsistent: { text: 'Inconsistent', Icon: Activity,    className: styles.tagMixed },
  active:       { text: 'Active',       Icon: CircleCheck, className: styles.tagActive },
  too_early:    { text: 'Too early',    Icon: Clock,       className: styles.tagEarly },
}

const DAY_CLASS: Record<DayState, string> = {
  updated:     styles.dayUpdated,
  silent:      styles.daySilent,
  not_counted: styles.dayNotCounted,
}

function PersonCard({ person, expanded, onToggle }: {
  person: PersonResponse
  expanded: boolean
  onToggle: () => void
}) {
  const { text, Icon, className } = LABELS[person.label]
  const summary = personSummary(person)

  return (
    <li className={`${styles.person} ${expanded ? styles.personOpen : ''}`}>
      <button type="button" className={styles.personButton} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.personTop}>
          <span className={styles.personName}>{person.name}</span>
          <span className={`${styles.tag} ${className}`}>
            <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
            {text}
          </span>
        </span>
        <span
          className={styles.strip}
          role="img"
          aria-label={`Updated on ${person.updatedDays} of ${person.countedDays} counted days`}
          style={{ gridTemplateColumns: `repeat(${STRIP_WORKING_DAYS}, minmax(0, 1fr))` }}
        >
          {person.days.map(day => (
            <i key={day.date} className={DAY_CLASS[day.state]} title={`${formatStripDay(day.date)}: ${day.why}`} />
          ))}
        </span>
        <span className={styles.line}>
          {summary.days && <b>{summary.days} </b>}
          {summary.reply}
          {summary.flags && <><br />{summary.flags}</>}
        </span>
      </button>

      {expanded && (
        <div className={styles.talk}>
          <h3 className={styles.talkHeading}>To discuss</h3>
          <ul className={styles.talkList}>
            {talkingPoints(person).map(point => <li key={point}>{point}</li>)}
          </ul>
        </div>
      )}
    </li>
  )
}

// The bar beside Assigned By Me, built the way the Dashboard's "At a glance" bar
// is: docked to the window's right edge from 1132px, and on anything narrower a
// one-line summary above the list that opens in place.
//
// Clicking a person filters the list to them through the page's own `assignee`
// URL state, and opens their card with the facts to raise. Someone with no open
// tasks has nothing to filter to, so only their card opens. Holds no task logic.
export function TeamResponseBar({ team, failed, selectedId, onSelect }: {
  /** Undefined until the first read answers. */
  team: TeamResponse | undefined
  failed: boolean
  /** The page's current assignee filter. */
  selectedId: string
  onSelect: (userId: string) => void
}) {
  const [openOnPhone, setOpenOnPhone] = useState(false)
  // A card opened for someone the list cannot filter to.
  const [localOpenId, setLocalOpenId] = useState('')
  const expandedId = selectedId || localOpenId

  const toggle = (person: PersonResponse) => {
    const closing = expandedId === person.userId
    setLocalOpenId(closing ? '' : person.userId)
    onSelect(closing || person.openTasks === 0 ? '' : person.userId)
  }

  return (
    <aside className={styles.bar} aria-labelledby="team-response-heading">
      <div className={styles.head}>
        <h2 id="team-response-heading" className={styles.heading}>Team response</h2>
        <p className={styles.sub}>On the tasks you assigned, last 2 weeks</p>
      </div>

      <button
        type="button"
        className={styles.toggle}
        aria-expanded={openOnPhone}
        onClick={() => setOpenOnPhone(v => !v)}
      >
        <span>
          <span className={styles.toggleTitle}>Team response</span>
          <span className={styles.toggleLine}>
            {team ? teamSummaryLine(team) : failed ? 'Could not load' : 'Loading…'}
          </span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className={openOnPhone ? styles.chevronOpen : undefined} />
      </button>

      <div className={`${styles.content} ${openOnPhone ? styles.contentOpen : ''}`}>
        {!team ? (
          <p className={styles.note} role={failed ? 'alert' : 'status'}>
            {failed ? 'This could not be loaded. Your tasks are not affected.' : 'Reading the last two weeks…'}
          </p>
        ) : team.people.length === 0 && team.inactive.length === 0 ? (
          <p className={styles.note}>Nobody to show yet. Assign a task and the person appears here.</p>
        ) : (
          <>
            {team.people.length > 0 && (
              <div className={styles.legend} aria-hidden="true">
                <span><i className={styles.dayUpdated} />Updated</span>
                <span><i className={styles.daySilent} />Silent</span>
                <span><i className={styles.dayNotCounted} />Not counted</span>
              </div>
            )}

            <ul className={styles.people}>
              {team.people.map(person => (
                <PersonCard
                  key={person.userId}
                  person={person}
                  expanded={expandedId === person.userId}
                  onToggle={() => toggle(person)}
                />
              ))}
            </ul>

            {team.inactive.length > 0 && (
              <div className={styles.inactive}>
                <h3 className={styles.inactiveHeading}>Inactive {team.inactive.length === 1 ? 'account' : 'accounts'}</h3>
                {team.inactive.map(person => (
                  <p key={person.userId}>
                    {person.name} has {person.openTasks} open {person.openTasks === 1 ? 'task' : 'tasks'}.
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
