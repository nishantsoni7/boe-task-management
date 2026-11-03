'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, Ban, Check, MessageCircle, Phone, PhoneMissed, UserPlus } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { telHref } from '@/lib/exhibitionLeads/phone'
import { idParam, optionParam, textParam } from '@/lib/listState'
import { fetchBoard, SALES_KEY, type BoardData, type WorkLead } from '@/lib/salesLeads/api'
import {
  BOARD_STAGES, MARKETS, MARKET_VALUES, SEGMENTS, SEGMENT_VALUES, stageLabel, STAGE_KEYS, TEMPERATURES, TEMPERATURE_VALUES, valueLabel, type Stage,
} from '@/lib/salesLeads/board'
import { LEAD_SOURCES, LEAD_SOURCE_VALUES } from '@/lib/salesLeads/constants'
import { initialsOf, plural } from '@/lib/salesLeads/format'
import { Due, Flag, LeadChips, leadTitle, StepLine } from './LeadBits'
import { SalesFrame } from './SalesFrame'
import { useLeadWork, type LeadWork } from './useLeadWork'
import { WorkPanel } from './WorkPanel'
import s from './leadBoard.module.css'

// The Lead Board: every open lead this person may see, by stage. Cards drag on a desktop, and every card also has a
// Move button, because a phone cannot drag and nothing may depend on dragging alone. Each column sorts itself: overdue
// first, then today, then the rest, so nobody orders a board by hand.

const LIST_PARAMS = {
  holder: idParam(),
  market: optionParam(MARKET_VALUES),
  segment: optionParam(SEGMENT_VALUES),
  temperature: optionParam(TEMPERATURE_VALUES),
  source: optionParam(LEAD_SOURCE_VALUES),
  q: textParam(),
  stage: optionParam(STAGE_KEYS),
  /** Opens one lead: the Lead Master links here. */
  lead: idParam(),
}

export function BoardScreen() {
  const { ready, profile } = usePermissionContext()
  const { canAssign, canSeeAll, readOnly } = useSalesAccess()
  const work = useLeadWork()
  const { state, setState } = useListUrlState(LIST_PARAMS)
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(state.q, next => setState({ q: next }))
  const [dragging, setDragging] = useState<WorkLead | null>(null)
  const [over, setOver] = useState<Stage | null>(null)
  const [now] = useState(() => Date.now())
  const current: Stage = state.stage || 'new'
  const today = work.today

  const filter = { holder: state.holder, market: state.market, segment: state.segment, temperature: state.temperature, source: state.source, q: state.q }
  const board = useQuery({
    queryKey: [SALES_KEY, 'board', filter],
    queryFn: () => fetchBoard(work.supabase, filter),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled: ready,
  })
  const data = board.data
  // A senior or a view_all manager reads other people's leads; only the holder or somebody with assign works them.
  const mayWork = (lead: WorkLead) => canAssign || (!readOnly && lead.assigned_to === profile?.id)
  const seesOthers = canSeeAll || (data?.holders.length ?? 0) > 1
  const byStage = useMemo(() => {
    const map = new Map<string, WorkLead[]>()
    // The database has already put them in order.
    for (const row of data?.rows ?? []) map.set(row.stage, [...(map.get(row.stage) ?? []), row])
    return map
  }, [data])

  function drop(stage: Stage) {
    if (dragging && mayWork(dragging)) work.moveTo(dragging, stage)
    setDragging(null)
    setOver(null)
  }
  const dropProps = (stage: Stage) => ({
    onDragOver: (e: React.DragEvent) => { if (dragging) { e.preventDefault(); setOver(stage) } },
    onDragLeave: () => setOver(o => (o === stage ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(stage) },
  })

  const hasFilters = !!(state.market || state.segment || state.temperature || state.source || state.q)
  const count = (stage: Stage) => data?.stages[stage]?.n ?? 0
  const allTabs: readonly Stage[] = [...BOARD_STAGES, 'converted', 'dead']

  const select = (key: 'market' | 'segment' | 'temperature' | 'source', label: string, options: readonly { value: string; label: string }[]) => (
    <select className={`${s.filter}${state[key] ? ` ${s.filterSet}` : ''}`} aria-label={label} value={state[key]} onChange={e => setState({ [key]: e.target.value } as never)}>
      <option value="">{label}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )

  let body: React.ReactNode
  if (!ready || (board.isPending && !data)) {
    body = <LoadingScreen message="Loading the board..." />
  } else if (board.isError && !data) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">The board could not be loaded</p>
        <p>Check your connection and try again.</p>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={() => board.refetch()}>Try again</button>
      </div>
    )
  } else {
    body = (
      <div className={`${s.wrap}${dragging ? ` ${s.dragging}` : ''}`}>
        <div className={`fin-stats ${s.stats}`} role="group" aria-label="The board at a glance">
          <div className="fin-stat"><span className="fin-stat-label">Open leads</span><span className="fin-stat-value" style={{ display: 'block' }}>{data?.stats.open.toLocaleString('en-IN')}</span><span className="fin-stat-sub" style={{ display: 'block' }}>{data && data.stats.value_paise > 0 ? `${valueLabel(data.stats.value_paise)} expected` : 'on the board'}</span></div>
          <div className="fin-stat"><span className="fin-stat-label">Overdue</span><span className={`fin-stat-value ${s.red}`} style={{ display: 'block' }}>{data?.stats.overdue.toLocaleString('en-IN')}</span><span className="fin-stat-sub" style={{ display: 'block' }}>follow-ups missed</span></div>
          <div className="fin-stat"><span className="fin-stat-label">Due today</span><span className={`fin-stat-value ${s.amber}`} style={{ display: 'block' }}>{data?.stats.due_today.toLocaleString('en-IN')}</span><span className="fin-stat-sub" style={{ display: 'block' }}>to call today</span></div>
          <div className="fin-stat"><span className="fin-stat-label">Stuck</span><span className={`fin-stat-value ${s.red}`} style={{ display: 'block' }}>{data?.stats.stuck.toLocaleString('en-IN')}</span><span className="fin-stat-sub" style={{ display: 'block' }}>no update for too long</span></div>
        </div>

        <section className="fin-board" aria-label="Lead Board">
          <div className="fin-viewbar">
            <div className="fin-tools" role="search" aria-label="Search leads">
              <label className="boe-list-search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#686D6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input type="search" aria-label="Search leads" placeholder="Phone, name or location" value={searchInput} onChange={e => setSearchInput(e.target.value)} onBlur={flushSearch} />
                {searchInput && <button type="button" className="boe-list-search-clear" aria-label="Clear search" onClick={() => { setSearchInput(''); setState({ q: '' }) }}>✕</button>}
              </label>
              {select('segment', 'Segment', SEGMENTS)}
              {select('market', 'Market', MARKETS)}
              {select('temperature', 'Hot / Warm / Cold', TEMPERATURES)}
              {select('source', 'Source', LEAD_SOURCES)}
              {!!data?.waiting_allotment && (
                <div className={s.toolsEnd}>
                  <Link className={s.queue} href="/sales/lead-master?holder=none&period=all"><UserPlus aria-hidden="true" />{data.waiting_allotment.toLocaleString('en-IN')} waiting to be allotted</Link>
                </div>
              )}
            </div>
          </div>

          {seesOthers && <WhoBar data={data} holder={state.holder} onPick={holder => setState({ holder })} />}

          <div className={s.tabs} role="group" aria-label="Stage">
            {allTabs.map(stage => (
              <button key={stage} type="button" className={s.tab} aria-pressed={current === stage} onClick={() => setState({ stage })}>
                {stageLabel(stage)} <span className={s.count}>{count(stage)}</span>
              </button>
            ))}
          </div>

          <div className={s.cols}>
            {BOARD_STAGES.map(stage => (
              <Column key={stage} stage={stage} data={data} rows={byStage.get(stage) ?? []} current={current === stage} over={over === stage} {...dropProps(stage)}>
                {(byStage.get(stage) ?? []).map(lead => (
                  <Card key={lead.id} lead={lead} today={today} now={now} work={work} canWork={mayWork(lead)} showHolder={seesOthers} dragged={dragging?.id === lead.id}
                    onOpen={() => setState({ lead: lead.id })} onDrag={setDragging} onDragEnd={() => { setDragging(null); setOver(null) }} />
                ))}
              </Column>
            ))}
            {/* Only a phone tab shows these two lists; on a desktop they are the two slim strips. */}
            {(['converted', 'dead'] as const).map(stage => (
              <Column key={stage} stage={stage} data={data} rows={byStage.get(stage) ?? []} current={current === stage} over={false} closed>
                {(byStage.get(stage) ?? []).map(lead => (
                  <Card key={lead.id} lead={lead} today={today} now={now} work={work} canWork={false} showHolder={seesOthers} dragged={false}
                    onOpen={() => setState({ lead: lead.id })} onDrag={() => {}} onDragEnd={() => {}} />
                ))}
              </Column>
            ))}
            <Exit stage="converted" count={count('converted')} hint="Drop here. All its details stay." over={over === 'converted'} dragging={!!dragging} {...dropProps('converted')} onShow={() => setState({ stage: 'converted' })} />
            <Exit stage="dead" count={count('dead')} hint="Drop here. It will ask why." over={over === 'dead'} dragging={!!dragging} {...dropProps('dead')} onShow={() => setState({ stage: 'dead' })} />
          </div>

          <div className="fin-footer">
            <span>
              {data ? plural(data.stats.open, 'open lead') : ''}{hasFilters ? ' match these filters' : ''}. Each column shows the most urgent first.
              {' '}Converted and Dead cover the last 30 days.
            </span>
            {hasFilters && <button type="button" className="boe-btn boe-btn-secondary" onClick={() => { setSearchInput(''); setState({ market: '', segment: '', temperature: '', source: '', q: '' }) }}>Clear the filters</button>}
          </div>
        </section>
      </div>
    )
  }

  return (
    <SalesFrame title="Lead Board" subtitle={profile ? 'Every open lead, and what happens next' : undefined}>
      {body}
      {state.lead && <WorkPanel leadId={state.lead} work={work} onClose={() => setState({ lead: '' })} />}
      {work.node}
    </SalesFrame>
  )
}

function WhoBar({ data, holder, onPick }: { data: BoardData | undefined; holder: string; onPick: (id: string) => void }) {
  const holders = data?.holders ?? []
  const everyone = holders.reduce((n, h) => n + h.n, 0)
  return (
    <div className={s.whoBar} role="group" aria-label="Leads of">
      <span className={s.whoLabel}>Leads of</span>
      <button type="button" className={`${s.who} ${s.whoAll}`} aria-pressed={holder === ''} onClick={() => onPick('')}>Everyone <span className={s.count}>{everyone}</span></button>
      {holders.map(h => (
        <button key={h.id} type="button" className={s.who} aria-pressed={holder === h.id} onClick={() => onPick(h.id)}>
          <span className={s.avatar} aria-hidden="true">{initialsOf(h.name)}</span>{h.name} <span className={s.count}>{h.n}</span>
        </button>
      ))}
    </div>
  )
}

function Column({ stage, data, rows, current, over, closed = false, children, ...drop }: {
  stage: Stage; data: BoardData | undefined; rows: WorkLead[]; current: boolean; over: boolean; closed?: boolean; children: React.ReactNode
} & Partial<React.HTMLAttributes<HTMLElement>>) {
  const info = data?.stages[stage]
  const cls = [s.col, stage === 'follow_up_later' && s.colLater, closed && s.colClosed, current && s.colCurrent, over && s.colOver].filter(Boolean).join(' ')
  return (
    <section className={cls} aria-label={stageLabel(stage)} {...drop}>
      <header className={s.colHead}>
        <h2 className={s.colName}>{stageLabel(stage)}</h2>
        <span className={s.colCount}>{info?.n ?? 0}</span>
        {!!info?.value_paise && <span className={s.colSum}>{valueLabel(info.value_paise)}</span>}
      </header>
      <div className={s.colList}>{children}</div>
      {rows.length === 0 && <div className={s.colEmpty}>No leads here</div>}
      {!!info && info.n > rows.length && <div className={s.colMore}>Showing the {rows.length} most urgent of {info.n}. Search or filter to find the rest.</div>}
    </section>
  )
}

function Exit({ stage, count, hint, over, dragging, onShow, ...drop }: {
  stage: 'converted' | 'dead'; count: number; hint: string; over: boolean; dragging: boolean; onShow: () => void
} & Partial<React.HTMLAttributes<HTMLButtonElement>>) {
  const Icon = stage === 'converted' ? Check : Ban
  return (
    <button type="button" className={`${s.exit} ${stage === 'converted' ? s.exitConv : s.exitDead}${over ? ` ${s.exitOver}` : ''}`} aria-label={`${stageLabel(stage)}, ${count} in the last 30 days`} onClick={onShow} {...drop}>
      <Icon aria-hidden="true" />
      <span className={s.exitName}>{stageLabel(stage)}</span>
      <span className={s.exitCount}>{count}</span>
      {dragging && <span className={s.exitHint}>{hint}</span>}
    </button>
  )
}

function Card({ lead, today, now, work, canWork, showHolder, dragged, onOpen, onDrag, onDragEnd }: {
  lead: WorkLead; today: string; now: number; work: LeadWork; canWork: boolean; showHolder: boolean; dragged: boolean
  onOpen: () => void; onDrag: (lead: WorkLead) => void; onDragEnd: () => void
}) {
  const stop = (run: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); run() }
  const cls = [s.card, lead.stuck && s.cardStuck, dragged && s.cardDragging].filter(Boolean).join(' ')
  return (
    <article
      className={cls}
      tabIndex={0}
      aria-label={`${leadTitle(lead)}, ${stageLabel(lead.stage)}`}
      draggable={canWork}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDrag(lead) }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}
    >
      <div className={s.cardTop}>
        <h3 className={`${s.name}${lead.name ? '' : ` ${s.phoneName}`}`}>{leadTitle(lead)}</h3>
        {showHolder && lead.holder_name && <span className={s.avatar} title={lead.holder_name}>{initialsOf(lead.holder_name)}</span>}
      </div>
      <LeadChips lead={lead} />
      <StepLine step={lead.next_step} />
      <div className={s.foot}><Due lead={lead} today={today} plain /><Flag lead={lead} now={now} plain /></div>
      {canWork && (
        <div className={s.acts}>
          <a className={s.act} href={telHref(lead.phone)} aria-label={`Call ${leadTitle(lead)}`} title="Call" onClick={e => e.stopPropagation()}><Phone aria-hidden="true" /><span className={s.actLabel}>Call</span></a>
          <button type="button" className={s.act} aria-label={`WhatsApp ${leadTitle(lead)}`} title="WhatsApp" onClick={stop(() => work.openWhatsApp(lead))}><MessageCircle aria-hidden="true" /><span className={s.actLabel}>WhatsApp</span></button>
          <button type="button" className={s.act} aria-label={`No answer from ${leadTitle(lead)}`} title="No answer" disabled={work.busy} onClick={stop(() => work.noAnswer(lead))}><PhoneMissed aria-hidden="true" /><span className={s.actLabel}>No answer</span></button>
          <button type="button" className={s.act} aria-label={`Move ${leadTitle(lead)}`} title="Move" onClick={stop(() => work.openMove(lead))}><ArrowRight aria-hidden="true" /><span className={s.actLabel}>Move</span></button>
        </div>
      )}
    </article>
  )
}
