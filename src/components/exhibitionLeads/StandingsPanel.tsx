'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Trophy } from 'lucide-react'
import { boardRows, joinNames, ordinal, summarise, type Standings } from '@/lib/exhibitionLeads/standings'
import a from './addLead.module.css'

// The scoreboard at the top of Add Lead: Today, Total, and where I stand —
// plus the leaderboard behind the rank tile. Today and Total are links to My
// Leads; the rank tile opens the board on a phone (it is always open on a wide
// screen). Numbers that change play a short pop so a save is felt, not read.

function useChangePop(value: number | null | undefined) {
  const [popKey, setPopKey] = useState(0)
  const last = useRef(value)
  useEffect(() => {
    if (last.current !== value && value != null && last.current != null) setPopKey(k => k + 1)
    last.current = value
  }, [value])
  return popKey
}

export function StatTiles({
  data, loading, day, myLeadsHref, totalHref, boardOpen, onToggleBoard,
}: {
  data: Standings | undefined
  loading: boolean
  /** "Day 2 of 3" while the exhibition is running. */
  day: string | null
  myLeadsHref: string
  totalHref: string
  boardOpen: boolean
  onToggleBoard: () => void
}) {
  const sum = summarise(data)
  const me = sum.me
  const today = me?.today
  const total = me?.total
  const todayPop = useChangePop(today)
  const totalPop = useChangePop(total)
  const rankPop = useChangePop(me?.rank)
  const ranked = !!me && me.rank != null && !data?.degraded
  const first = ranked && me.rank === 1
  const num = (v: number | undefined, pop: number) => (
    v === undefined
      ? (loading ? <span className={a.skel} aria-hidden="true" /> : <span className={`${a.tileValue} ${a.dim}`}>–</span>)
      : <span key={pop} className={`${a.tileValue}${pop ? ` ${a.pop}` : ''}`}>{v}</span>
  )

  return (
    <div className={a.stats}>
      <Link href={myLeadsHref} className={a.tile} aria-label={`My leads today: ${today ?? 'loading'}`}>
        <span className={a.tileLabel}>Today</span>
        {num(today, todayPop)}
        <span className={a.tileSub}>{day ?? 'My leads'}</span>
        <ChevronRight size={16} className={a.tileGo} aria-hidden="true" />
      </Link>

      <Link href={totalHref} className={a.tile} aria-label={`My total leads: ${total ?? 'loading'}`}>
        <span className={a.tileLabel}>Total</span>
        {num(total, totalPop)}
        <span className={a.tileSub}>All days</span>
        <ChevronRight size={16} className={a.tileGo} aria-hidden="true" />
      </Link>

      <button
        type="button"
        className={`${a.tile} ${a.tileRank}${first ? ` ${a.tileRankFirst}` : ''}`}
        aria-expanded={boardOpen}
        aria-controls="leaderboard"
        aria-label={ranked ? `My rank: ${ordinal(me.rank as number)} of ${data?.participants}. Show leaderboard` : 'Show leaderboard'}
        onClick={onToggleBoard}
      >
        <span className={a.tileLabel}>Rank</span>
        {ranked
          ? <span key={rankPop} className={`${a.tileValue}${rankPop ? ` ${a.pop}` : ''}`}>#{me.rank}</span>
          : data && !loading ? <span className={`${a.tileValue} ${a.dim}`}>–</span>
          : <span className={a.skel} aria-hidden="true" />}
        <span className={a.tileSub}>
          {ranked ? `of ${data?.participants}` : data && me?.total === 0 ? 'Add a lead' : ' '}
        </span>
        <ChevronDown size={16} className={a.tileGo} aria-hidden="true" />
      </button>
    </div>
  )
}

const badgeClass = (rank: number | null) =>
  rank === 1 ? `${a.badge} ${a.badge1}` : rank === 2 ? `${a.badge} ${a.badge2}` : rank === 3 ? `${a.badge} ${a.badge3}` : a.badge

export function Leaderboard({
  data, open, onToggle,
}: { data: Standings | undefined; open: boolean; onToggle: () => void }) {
  const [all, setAll] = useState(false)
  if (!data || data.degraded || data.rows.length < 2) return null
  const sum = summarise(data)
  const shown = boardRows(data.rows, 5, all)

  return (
    <section id="leaderboard" className={`${a.board} ${a.boardCard}${open ? ` ${a.boardOpen}` : ''}`} aria-label="Leaderboard">
      <button type="button" className={a.boardHead} aria-expanded={open} onClick={onToggle}>
        <span className={a.boardIcon} aria-hidden="true"><Trophy size={18} /></span>
        <span className={a.boardText}>
          <div className={a.boardTitle}>{data.is_final ? 'Final standings' : 'Leaderboard'}</div>
          <div className={a.boardLine}>
            {sum.headline || (sum.leaders.length ? `${joinNames(sum.leaders.map(l => l.name))} leads` : 'No leads yet')}
          </div>
        </span>
        <ChevronDown size={18} className={a.chev} aria-hidden="true" />
      </button>

      <div className={a.boardBody}>
        <ol className={a.rows}>
          <li className={`${a.row} ${a.rowHead}`} aria-hidden="true">
            <span>#</span><span>Salesperson</span><span>Today</span><span>Total</span>
          </li>
          {shown.map((r, i) => (
            <Fragment key={`${r.name}-${i}`}>
              {r.gapBefore && <li className={a.skipped} aria-hidden="true">· · ·</li>}
              <li className={`${a.row}${r.is_me ? ` ${a.rowMe}` : ''}`} aria-current={r.is_me ? 'true' : undefined}>
                <span className={badgeClass(r.rank)}>{r.rank ?? '–'}</span>
                <span className={a.rowName}><span>{r.name}</span>{r.is_me && <span className={a.you}>You</span>}</span>
                <span>{r.today}</span>
                <span className={a.rowTotal}>{r.total}</span>
              </li>
            </Fragment>
          ))}
        </ol>
        <div className={a.boardFoot}>
          <span>
            {sum.topToday
              ? `Top today: ${joinNames(sum.topToday.names)} (${sum.topToday.count})`
              : 'Counted by who collected the lead'}
          </span>
          {data.rows.length > 5 && (
            <button type="button" onClick={() => setAll(v => !v)}>
              {all ? 'Show top 5' : `Show all ${data.rows.length}`}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
