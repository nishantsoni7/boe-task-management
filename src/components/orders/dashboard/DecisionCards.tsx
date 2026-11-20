'use client'

// THE APPROVER'S ORDERS DASHBOARD, drawn (owner-approved preview, 2026-11-20). Two kinds of work, drawn differently:
//
//   Needs your action   one white sheet. Each row needs a decision and has one button. Three groups share one set of columns:
//                       New PIs to approve · Changes on running orders · Clarifications from Operations.
//   Watching            the same columns, flat on the page, with a wait bar where the button would be: Sales or Operations holds
//                       it, nothing is asked of the reader, so it is for chasing. A quiet chevron stands where the button would be.
//
// ONE HEADER PER SECTION (owner, 2026-11-20: two header rows read as two headers): no column-heading row; a group's name is shown
// only when the sheet has more than one group, and "Start with" only when there is more than one row to choose from.
// EVERYTHING EMPTY IS LEFT OUT: a group with no rows, a section with no rows, and their headings. When nothing waits anywhere one line
// says so, but never when a read failed (then the notes say what failed and nothing claims "all clear"). Design Files / Client PO
// submissions are rows of "Changes on running orders": Sales proposing new or replacement files for an order.
//
// Which group a row sits in is lib/orders/adminDashboard.ts (splitCards): who holds the next move right now. This file only draws it.
// The row that has waited longest on the sheet is the "Start with" row: its button is the only solid one, and it is the only row tinted.

import { useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { ChevronRight, CircleCheck, Clock, FileText, TriangleAlert } from 'lucide-react'
import { formatWaiting } from '@/lib/orders/orderDashboardSummary'
import { FLAGGED_LOAD_FAILED } from '@/lib/orders/flaggedPis'
import {
  CARD_DEFS,
  CARD_VISIBLE_ROWS,
  CHANGES_LOAD_FAILED,
  firstName,
  peopleOf,
  personKey,
  sinceLabel,
  splitCards,
  waitTone,
  type CardKey,
  type DecisionRow,
} from '@/lib/orders/adminDashboard'
import { TONE_ICON } from './AdminChip'
import styles from './adminDashboard.module.css'

export type DecisionState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; rows: DecisionRow[]; flaggedFailed?: boolean; changesFailed?: boolean }

const ACTION_GROUPS: readonly CardKey[] = ['new_pis', 'changes', 'from_ops']
const STATUS_CLASS = { ok: styles.stOk, warn: styles.stWarn, danger: styles.stBad, info: styles.stInfo, neutral: styles.stNeutral } as const
const ageClass = (tone: 'normal' | 'warn' | 'danger') => (tone === 'warn' ? styles.ageWarn : tone === 'danger' ? styles.ageDanger : '')

/** The wait, with the day it began under it. An icon slot is always there, so every wait starts at the same edge. */
function AgeCell({ r }: { r: DecisionRow }) {
  const tone = waitTone(r.waitSeconds)
  const Icon = tone === 'danger' ? TriangleAlert : Clock
  return (
    <span className={styles.cAge}>
      <span className={`${styles.cAgeMain} ${ageClass(tone)}`}>
        <span className={styles.ic}>{tone === 'normal' ? null : <Icon size={16} strokeWidth={2} aria-hidden="true" />}</span>
        {formatWaiting(r.waitSeconds)}
      </span>
      <span className={styles.sub}>Since {sinceLabel(r.sinceIso)}</span>
    </span>
  )
}

/** What was asked: a status (icon and words, never colour alone), the round when it has looped, and one line of detail. */
function AskCell({ r, plain }: { r: DecisionRow; plain: boolean }) {
  const chip = r.chip
  if (!chip) return <span className={styles.cAsk} />
  if (plain) return <span className={styles.cAsk}><span className={styles.q}>{chip.sub ?? chip.label}</span></span>
  const Icon = r.kind === 'pi_revision' || r.kind === 'change_request' || r.kind === 'documents' ? FileText : TONE_ICON[chip.tone]
  return (
    <span className={styles.cAsk}>
      <span className={`${styles.st} ${STATUS_CLASS[chip.tone]}`}>
        <Icon size={16} strokeWidth={2} aria-hidden="true" />{chip.label}
      </span>
      {r.round ? <span className={styles.round}>{r.round}</span> : null}
      {chip.sub ? <span className={styles.q}>{chip.sub}</span> : null}
    </span>
  )
}

function DecisionRowLink({ r, watching, solid }: { r: DecisionRow; watching?: boolean; solid?: boolean }) {
  const ask = r.chip ? `${r.chip.label}${r.chip.sub ? `: ${r.chip.sub}` : ''}` : ''
  const label = `${r.client}, ${r.order}: ${ask}. ${watching ? 'With' : 'From'} ${firstName(r.who.name) || 'nobody'}, waiting ${formatWaiting(r.waitSeconds)}.${watching ? '' : ` ${r.next}`}`
  return (
    <Link href={r.href} className={`${styles.row} ${solid ? styles.rowHot : ''}`} aria-label={label} prefetch={false}>
      <span className={styles.cOrd}>{r.order}</span>
      <span className={styles.cCli}><span className={styles.oi}>{r.order}</span>{r.client}</span>
      <AskCell r={r} plain={!!watching} />
      <span className={styles.cWho} title={r.who.caption}>
        <span className={styles.pre}>{watching ? 'with' : 'from'}</span><b className={styles.nm}>{firstName(r.who.name) || 'nobody'}</b>
      </span>
      <AgeCell r={r} />
      <span className={styles.cAct}>
        {watching ? (
          <ChevronRight className={styles.cChev} size={16} strokeWidth={2} aria-hidden="true" />
        ) : (
          <span className={`${styles.do} ${solid ? styles.doSolid : ''}`}>{r.next}</span>
        )}
      </span>
    </Link>
  )
}

function ActionSheet({ groups }: { groups: { key: CardKey; rows: DecisionRow[] }[] }) {
  const all = groups.flatMap(g => g.rows)
  // Rows arrive longest-waiting first, so the first row of the group that holds the longest wait is the one to start with.
  const start = all.reduce<DecisionRow | null>((best, r) => (best === null || r.waitSeconds > best.waitSeconds ? r : best), null)
  const startTone = start ? waitTone(start.waitSeconds) : 'normal'
  const StartIcon = startTone === 'danger' ? TriangleAlert : Clock
  return (
    <section className={styles.sheet} aria-labelledby="adm-act-h">
      <header className={styles.hd}>
        <h2 id="adm-act-h" className={styles.hdTitle}>Needs your action</h2>
        <span className={styles.badge}>{all.length}</span>
        {start && all.length > 1 ? (
          <Link href={start.href} className={`${styles.startLink} ${ageClass(startTone)}`} prefetch={false}>
            {startTone === 'normal' ? null : <StartIcon size={16} strokeWidth={2} aria-hidden="true" />}
            Start with {start.client}, waiting {formatWaiting(start.waitSeconds)}
          </Link>
        ) : null}
      </header>
      {groups.map(g => {
        const def = CARD_DEFS.find(d => d.key === g.key)
        return (
          <div key={g.key}>
            {groups.length > 1 ? (
              <div className={styles.band}>
                <span>{def?.title}</span><b>{g.rows.length}</b><span className={styles.bandR}>{def?.bandNote}</span>
              </div>
            ) : null}
            <ul className={styles.clist}>
              {g.rows.map(r => <li key={r.key}><DecisionRowLink r={r} solid={r === start} /></li>)}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function WatchingSection({ rows }: { rows: DecisionRow[] }) {
  const [who, setWho] = useState('all')
  const [open, setOpen] = useState(false)
  const people = peopleOf(rows)
  const picked = who === 'all' ? rows : rows.filter(r => personKey(r.who) === who)
  const shown = open ? picked : picked.slice(0, CARD_VISIBLE_ROWS)
  const pick = (key: string) => { setWho(key); setOpen(false) }
  return (
    <section className={styles.watch} aria-labelledby="adm-watch-h">
      <header className={styles.hd}>
        <h2 id="adm-watch-h" className={styles.hdTitleFlat}>Watching</h2>
        <span className={`${styles.badge} ${styles.badgeNeutral}`}>{rows.length}</span>
        <span className={styles.hint}>Held by Sales or Operations. Nothing for you to do; chase if it runs long.</span>
      </header>
      {people.length > 1 ? (
        <div className={styles.people} role="group" aria-label="Filter by person">
          <button type="button" className={styles.pchip} aria-pressed={who === 'all'} onClick={() => pick('all')}>All <b>{rows.length}</b></button>
          {people.map(p => {
            const tone = waitTone(p.oldestSeconds)
            return (
              <button key={p.key} type="button" className={styles.pchip} aria-pressed={who === p.key} onClick={() => pick(p.key)}>
                {firstName(p.name) || 'Nobody'} <b>{p.count}</b><span className={`${styles.po} ${ageClass(tone)}`}>{formatWaiting(p.oldestSeconds)}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <ul className={styles.clist}>
        {shown.map(r => <li key={r.key}><DecisionRowLink r={r} watching /></li>)}
      </ul>
      {picked.length > CARD_VISIBLE_ROWS ? (
        <button type="button" className={styles.showall} onClick={() => setOpen(o => !o)}>{open ? 'Show fewer' : `Show all ${picked.length}`}</button>
      ) : null}
    </section>
  )
}

export function DecisionCards({ state }: { state: DecisionState }) {
  if (state.kind === 'loading') {
    return <div className={styles.skeleton} aria-busy="true" aria-label="Loading what is waiting for you" />
  }
  if (state.kind === 'error') {
    return <section className={styles.card}><p className={styles.note} role="alert">What is waiting for you could not be loaded. Refresh to try again.</p></section>
  }
  if (state.kind === 'unavailable') {
    return <section className={styles.card}><p className={styles.note}>This list is not shown while you view as someone else.</p></section>
  }
  const cards = splitCards(state.rows)
  const groups = ACTION_GROUPS.map(key => ({ key, rows: cards[key] })).filter(g => g.rows.length > 0)
  const unreadable = !!state.flaggedFailed || !!state.changesFailed
  const nothing = groups.length === 0 && cards.waiting.length === 0
  return (
    <div className={styles.cardsWrap}>
      {state.flaggedFailed ? <section className={styles.card}><p className={styles.note} role="alert">{FLAGGED_LOAD_FAILED}</p></section> : null}
      {state.changesFailed ? <section className={styles.card}><p className={styles.note} role="alert">{CHANGES_LOAD_FAILED}</p></section> : null}
      {groups.length > 0 ? <ActionSheet groups={groups} /> : null}
      {cards.waiting.length > 0 ? <WatchingSection rows={cards.waiting} /> : null}
      {nothing && !unreadable ? (
        <div className={styles.clear}><CircleCheck size={20} aria-hidden="true" /><span>Nothing is waiting on you, and nobody is holding anything for you.</span></div>
      ) : null}
    </div>
  )
}

