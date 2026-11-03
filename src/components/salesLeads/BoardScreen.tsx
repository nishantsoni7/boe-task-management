'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, Ban, Bell, Check, ChevronDown, ChevronsLeft, MessageCircle, Phone, PhoneMissed, SlidersHorizontal, UserPlus } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { telHref } from '@/lib/exhibitionLeads/phone'
import { idParam, optionParam, textParam } from '@/lib/listState'
import { fetchBoard, fetchBoardPage, SALES_KEY, type BoardData, type BoardFilter, type WorkLead } from '@/lib/salesLeads/api'
import { COLUMN_PAGE, nextOffset, uniqueRows } from '@/lib/salesLeads/boardPage'
import {
  BOARD_STAGES, cameBack, flagOf, marketLabel, MARKETS, MARKET_VALUES, SEGMENTS, SEGMENT_VALUES, stageLabel, STAGE_KEYS, TEMPERATURES,
  TEMPERATURE_VALUES, valueLabel, type Stage,
} from '@/lib/salesLeads/board'
import { LEAD_SOURCES, LEAD_SOURCE_VALUES } from '@/lib/salesLeads/constants'
import { initialsOf } from '@/lib/salesLeads/format'
import { Due, Flag, leadTitle, StepLine, ValueChip } from './LeadBits'
import { SalesFrame } from './SalesFrame'
import { useLeadWork, type LeadWork } from './useLeadWork'
import { WorkPanel } from './WorkPanel'
import s from './leadBoard.module.css'

// The Lead Board: every open lead this person may see, by stage. The page itself never scrolls: a toolbar, the totals
// when they are asked for, then one column per stage, each with its own scroller that keeps loading as you reach the
// end. Cards drag on a desktop, and every card also has a Move button, because a phone cannot drag and nothing may
// depend on dragging alone. Each column is in the order the database gives it: overdue first, then today, then the
// rest, Hot before Warm before Cold, so nobody orders a board by hand.

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

type Closed = 'converted' | 'dead'
const CLOSED: readonly Closed[] = ['converted', 'dead']

/** What this person chose last on this browser (the totals open, the folded columns). Nothing to remember it in is fine. */
function useRemembered<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch { return fallback }
  })
  const set = (next: T) => {
    setValue(next)
    try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* nothing to remember it in */ }
  }
  return [value, set]
}

/** A phone-sized screen: one column at a time, so only that column is read, and a folded column is shown anyway. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    notify => { const m = window.matchMedia('(max-width: 700px)'); m.addEventListener('change', notify); return () => m.removeEventListener('change', notify) },
    () => window.matchMedia('(max-width: 700px)').matches,
    () => false,
  )
}

/** One column's leads, a page at a time. A lead that moved while the pages were loading is shown once. */
function useColumn(stage: Stage, filter: BoardFilter, supabase: LeadWork['supabase'], enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [SALES_KEY, 'board', 'column', stage, filter],
    queryFn: ({ pageParam }) => fetchBoardPage(supabase, stage, pageParam, COLUMN_PAGE, filter),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled,
  })
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
  const [totals, setTotals] = useRemembered<boolean>('boe.sales.board.totals', false)
  const [folded, setFolded] = useRemembered<Stage[]>('boe.sales.board.folded', [])
  /** On a desktop Converted and Dead are slim strips; this is the one opened as a column. */
  const [opened, setOpened] = useState<Closed | null>(null)
  const narrow = useNarrow()
  const current: Stage = state.stage || 'new'
  const today = work.today

  const filter: BoardFilter = { holder: state.holder, market: state.market, segment: state.segment, temperature: state.temperature, source: state.source, q: state.q }
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

  const filtersSet = [state.market, state.segment, state.temperature, state.source].filter(Boolean).length
  const count = (stage: Stage) => data?.stages[stage]?.n ?? 0
  const allTabs: readonly Stage[] = [...BOARD_STAGES, ...CLOSED]
  const holder = data?.holders.find(h => h.id === state.holder)

  const clearFilters = () => { setSearchInput(''); setState({ market: '', segment: '', temperature: '', source: '', q: '' }) }
  const select = (key: 'market' | 'segment' | 'temperature' | 'source', label: string, options: readonly { value: string; label: string }[]) => (
    <div className={s.menuField}>
      <label htmlFor={`board-${key}`}>{label}</label>
      <select id={`board-${key}`} value={state[key]} onChange={e => setState({ [key]: e.target.value } as never)}>
        <option value="">Any</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )

  let body: React.ReactNode
  if (!ready) {
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
        <div className={s.bar} role="search" aria-label="Search and filter leads">
          <label className={`boe-list-search ${s.search}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#686D6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input type="search" aria-label="Search leads" placeholder="Phone, name or location" value={searchInput} onChange={e => setSearchInput(e.target.value)} onBlur={flushSearch} />
            {searchInput && <button type="button" className="boe-list-search-clear" aria-label="Clear search" onClick={() => { setSearchInput(''); setState({ q: '' }) }}>✕</button>}
          </label>

          {seesOthers && (
            <ToolMenu
              label="Leads of"
              button={({ open, toggle }) => (
                <button type="button" className={`${s.tool}${holder ? ` ${s.toolSet}` : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                  {holder
                    ? <><span className={s.avatar} aria-hidden="true">{initialsOf(holder.name)}</span>{holder.name}</>
                    : <><span className={s.stack} aria-hidden="true">{(data?.holders ?? []).slice(0, 3).map(h => <span key={h.id} className={s.avatar}>{initialsOf(h.name)}</span>)}</span>Everyone</>}
                  <ChevronDown aria-hidden="true" />
                </button>
              )}
            >
              {close => (
                <>
                  <div className={s.menuHead}>Leads of</div>
                  <button type="button" role="menuitemradio" aria-checked={!state.holder} className={s.menuItem} onClick={() => { setState({ holder: '' }); close() }}>
                    Everyone <span className={s.count}>{(data?.holders ?? []).reduce((n, h) => n + h.n, 0).toLocaleString('en-IN')}</span>
                  </button>
                  {(data?.holders ?? []).map(h => (
                    <button key={h.id} type="button" role="menuitemradio" aria-checked={state.holder === h.id} className={s.menuItem} onClick={() => { setState({ holder: h.id }); close() }}>
                      <span className={s.avatar} aria-hidden="true">{initialsOf(h.name)}</span>{h.name} <span className={s.count}>{h.n.toLocaleString('en-IN')}</span>
                    </button>
                  ))}
                </>
              )}
            </ToolMenu>
          )}

          <ToolMenu
            label="Filters" role="group"
            button={({ open, toggle }) => (
              <button type="button" className={`${s.tool}${filtersSet ? ` ${s.toolSet}` : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                <SlidersHorizontal aria-hidden="true" />Filters{filtersSet > 0 && <span className={s.badge}>{filtersSet}</span>}
              </button>
            )}
          >
            {() => (
              <>
                {select('segment', 'Segment', SEGMENTS)}
                {select('market', 'Market', MARKETS)}
                {select('temperature', 'Hot / Warm / Cold', TEMPERATURES)}
                {select('source', 'Source', LEAD_SOURCES)}
                {(filtersSet > 0 || state.q) && <button type="button" className={`boe-btn boe-btn-secondary ${s.menuClear}`} onClick={clearFilters}>Clear the filters</button>}
              </>
            )}
          </ToolMenu>

          <span className={s.grow} />
          {data && (
            <button type="button" className={s.pulse} aria-expanded={totals} title="Show or hide the totals" onClick={() => setTotals(!totals)}>
              <b>{data.stats.open.toLocaleString('en-IN')}</b> open <span className={s.sep}>·</span>
              <b className={s.red}>{data.stats.overdue.toLocaleString('en-IN')}</b> overdue <span className={s.sep}>·</span>
              <b className={s.amber}>{data.stats.due_today.toLocaleString('en-IN')}</b> today
              <ChevronDown aria-hidden="true" />
            </button>
          )}
          {!!data?.waiting_allotment && (
            <Link className={s.queue} href="/sales/lead-master?holder=none&period=all"><UserPlus aria-hidden="true" />{data.waiting_allotment.toLocaleString('en-IN')} waiting to be allotted</Link>
          )}
        </div>

        {totals && data && (
          <div className={s.totals} role="group" aria-label="The board at a glance">
            <div className={s.stat}><span className={s.statValue}>{data.stats.open.toLocaleString('en-IN')}</span><span className={s.statLabel}>Open leads · {data.stats.value_paise > 0 ? `${valueLabel(data.stats.value_paise)} expected` : 'on the board'}</span></div>
            <div className={s.stat}><span className={`${s.statValue} ${s.red}`}>{data.stats.overdue.toLocaleString('en-IN')}</span><span className={s.statLabel}>Overdue · follow-ups missed</span></div>
            <div className={s.stat}><span className={`${s.statValue} ${s.amber}`}>{data.stats.due_today.toLocaleString('en-IN')}</span><span className={s.statLabel}>Due today · to call today</span></div>
            <div className={s.stat}><span className={`${s.statValue} ${s.red}`}>{data.stats.stuck.toLocaleString('en-IN')}</span><span className={s.statLabel}>Stuck · no update for too long</span></div>
          </div>
        )}

        <div className={s.tabs} role="group" aria-label="Stage">
          {allTabs.map(stage => (
            <button key={stage} type="button" className={s.tab} aria-pressed={current === stage} onClick={() => setState({ stage })}>
              {stageLabel(stage)} <span className={s.count}>{count(stage)}</span>
            </button>
          ))}
        </div>

        <div className={s.cols}>
          {BOARD_STAGES.map(stage => (
            <Column
              key={stage} stage={stage} filter={filter} data={data} work={work} today={today} now={now} enabled={ready && (!narrow || current === stage)}
              current={current === stage} over={over === stage} folded={folded.includes(stage) && !narrow} showHolder={seesOthers} dragging={dragging} openId={state.lead}
              canWork={mayWork} onOpen={id => setState({ lead: id })} onLeadDrag={setDragging} onLeadDragEnd={() => { setDragging(null); setOver(null) }}
              onFold={() => setFolded(folded.includes(stage) ? folded.filter(f => f !== stage) : [...folded, stage])}
              {...dropProps(stage)}
            />
          ))}
          {/* On a phone a tab shows these two lists; on a desktop each is a slim strip that opens as a column. */}
          {CLOSED.map(stage => (
            <Column
              key={stage} stage={stage} filter={filter} data={data} work={work} today={today} now={now} enabled={ready && (narrow ? current === stage : opened === stage)}
              current={current === stage} over={over === stage} closed shown={opened === stage} folded={false} showHolder={seesOthers} dragging={dragging} openId={state.lead}
              canWork={() => false} onOpen={id => setState({ lead: id })} onLeadDrag={() => {}} onLeadDragEnd={() => {}} onFold={() => setOpened(null)}
              {...dropProps(stage)}
            />
          ))}
          {CLOSED.map(stage => (
            <Exit key={stage} stage={stage} count={count(stage)} gone={opened === stage} hint={stage === 'dead' ? 'Drop here. It will ask why.' : 'Drop here. All its details stay.'} over={over === stage} dragging={!!dragging}
              {...dropProps(stage)} onShow={() => setOpened(stage)} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <SalesFrame title="Lead Board" subtitle={profile ? 'Every open lead, and what happens next' : undefined} fill>
      {body}
      {state.lead && <WorkPanel leadId={state.lead} work={work} onClose={() => setState({ lead: '' })} />}
      {work.node}
    </SalesFrame>
  )
}

/** A button that opens a small menu under it. Clicking away or pressing Escape closes it. */
function ToolMenu({ button, label, role = 'menu', children }: {
  button: (p: { open: boolean; toggle: () => void }) => React.ReactNode
  label: string
  role?: 'menu' | 'group'
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  return (
    <div ref={box} className={s.menuWrap}>
      {button({ open, toggle: () => setOpen(o => !o) })}
      {open && <div className={s.menu} role={role} aria-label={label}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

function Column({ stage, filter, data, work, today, now, enabled, current, over, closed = false, shown = false, folded, showHolder, dragging, openId, canWork, onOpen, onLeadDrag, onLeadDragEnd, onFold, ...drop }: {
  stage: Stage; filter: BoardFilter; data: BoardData | undefined
  work: LeadWork; today: string; now: number; enabled: boolean; current: boolean; over: boolean; closed?: boolean; shown?: boolean; folded: boolean
  showHolder: boolean; dragging: WorkLead | null; openId: string; canWork: (lead: WorkLead) => boolean
  onOpen: (id: string) => void; onLeadDrag: (lead: WorkLead) => void; onLeadDragEnd: () => void; onFold: () => void
} & Partial<React.HTMLAttributes<HTMLElement>>) {
  const q = useColumn(stage, filter, work.supabase, enabled && !folded)
  const rows = useMemo(() => uniqueRows(q.data?.pages), [q.data])
  // A column that is not being read (folded) keeps the numbers of the filter it last had; show the board's own instead.
  const first = q.isPlaceholderData ? undefined : q.data?.pages[0]
  const n = first?.n ?? data?.stages[stage]?.n ?? 0
  const value = data?.stages[stage]?.value_paise ?? 0
  const list = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q

  // Reaching the end of the list asks for the next page. A list that does not fill the column asks until it does.
  useEffect(() => {
    const target = end.current
    const root = list.current
    // After a failed page it waits for the person to press Try again, instead of asking again and again.
    if (!target || !root || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
    const watcher = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) void fetchNextPage({ cancelRefetch: false }) }, { root, rootMargin: '240px' })
    watcher.observe(target)
    return () => watcher.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, rows.length])

  const cls = [s.col, stage === 'follow_up_later' && s.colLater, closed && s.colClosed, closed && shown && s.colShown, current && s.colCurrent, over && s.colOver, folded && s.colFolded]
    .filter(Boolean).join(' ')
  const late = first?.overdue ?? 0
  return (
    <section
      className={cls} aria-label={folded ? `Unfold ${stageLabel(stage)}` : stageLabel(stage)} {...drop}
      {...(folded ? { role: 'button', tabIndex: 0, onClick: onFold, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFold() } } } : {})}
    >
      <header className={s.colHead}>
        <h2 className={s.colName}>{stageLabel(stage)}</h2>
        <span className={s.colCount}>{n.toLocaleString('en-IN')}</span>
        {late > 0 && <span className={s.colLate} title={`${late} overdue`}>{late.toLocaleString('en-IN')} overdue</span>}
        {!folded && (
          <button type="button" className={s.fold} title={closed ? 'Close this list' : 'Fold this column'} aria-label={`${closed ? 'Close' : 'Fold'} ${stageLabel(stage)}`} onClick={e => { e.stopPropagation(); onFold() }}>
            <ChevronsLeft aria-hidden="true" />
          </button>
        )}
      </header>
      <div ref={list} className={s.colList}>
        {rows.map(lead => (
          <Card key={lead.id} lead={lead} today={today} now={now} work={work} canWork={canWork(lead)} showHolder={showHolder} open={openId === lead.id} dragged={dragging?.id === lead.id}
            onOpen={() => onOpen(lead.id)} onDrag={onLeadDrag} onDragEnd={onLeadDragEnd} />
        ))}
        {q.isPending && enabled && <div className={s.colLoading}>Loading…</div>}
        {q.isError && rows.length === 0 && (
          <div className={s.colEmpty}>Could not load. <button type="button" className={s.linkBtn} onClick={() => void q.refetch()}>Try again</button></div>
        )}
        {q.isSuccess && n === 0 && <div className={s.colEmpty}>No leads here</div>}
        {hasNextPage && <div ref={end} className={s.sentinel} aria-hidden="true" />}
        {isFetchingNextPage && <div className={s.colLoading}>Loading more…</div>}
        {isFetchNextPageError && (
          <div className={s.colEmpty}>Could not load more. <button type="button" className={s.linkBtn} onClick={() => void fetchNextPage({ cancelRefetch: false })}>Try again</button></div>
        )}
      </div>
      <div className={s.colFoot}>
        <span>{rows.length >= n ? `All ${n.toLocaleString('en-IN')} shown` : `${rows.length.toLocaleString('en-IN')} of ${n.toLocaleString('en-IN')} shown`}</span>
        {value > 0 && <span title="Expected value of these leads">{valueLabel(value)}</span>}
      </div>
    </section>
  )
}

function Exit({ stage, count, hint, over, dragging, gone, onShow, ...drop }: {
  stage: Closed; count: number; hint: string; over: boolean; dragging: boolean; gone: boolean; onShow: () => void
} & Partial<React.HTMLAttributes<HTMLButtonElement>>) {
  const Icon = stage === 'converted' ? Check : Ban
  return (
    <button type="button" className={`${s.exit} ${stage === 'converted' ? s.exitConv : s.exitDead}${over ? ` ${s.exitOver}` : ''}${gone ? ` ${s.exitGone}` : ''}`} aria-label={`${stageLabel(stage)}, ${count} in the last 30 days`} onClick={onShow} {...drop}>
      <Icon aria-hidden="true" />
      <span className={s.exitName}>{stageLabel(stage)}</span>
      <span className={s.exitCount}>{count}</span>
      {dragging && <span className={s.exitHint}>{hint}</span>}
    </button>
  )
}

function Card({ lead, today, now, work, canWork, showHolder, open, dragged, onOpen, onDrag, onDragEnd }: {
  lead: WorkLead; today: string; now: number; work: LeadWork; canWork: boolean; showHolder: boolean; open: boolean; dragged: boolean
  onOpen: () => void; onDrag: (lead: WorkLead) => void; onDragEnd: () => void
}) {
  const stop = (run: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); run() }
  const cls = [s.card, open && s.cardOpen, lead.stuck && s.cardStuck, dragged && s.cardDragging].filter(Boolean).join(' ')
  const heat = { hot: s.heatHot, warm: s.heatWarm, cold: s.heatCold }[lead.temperature]
  const hasNote = lead.market === 'export' || !!lead.expected_value_paise || cameBack(lead) || !!flagOf(lead, now)
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
        <span className={`${s.heat} ${heat}`} role="img" aria-label={lead.temperature === 'hot' ? 'Hot' : lead.temperature === 'warm' ? 'Warm' : 'Cold'} title={lead.temperature === 'hot' ? 'Hot' : lead.temperature === 'warm' ? 'Warm' : 'Cold'} />
        <h3 className={`${s.name}${lead.name ? '' : ` ${s.phoneName}`}`}>{leadTitle(lead)}</h3>
        {showHolder && lead.holder_name && <span className={s.avatar} title={lead.holder_name}>{initialsOf(lead.holder_name)}</span>}
      </div>
      <div className={s.cardMid}>
        <StepLine step={lead.next_step} />
        <Due lead={lead} today={today} plain />
      </div>
      {hasNote && (
        <div className={s.cardNote}>
          <div className={s.chips}>
            {lead.market === 'export' && <span className={`${s.chip} ${s.chipExport}`}>{marketLabel(lead)}</span>}
            <ValueChip paise={lead.expected_value_paise} />
            {cameBack(lead) && <span className={`${s.chip} ${s.chipAgain}`}><Bell aria-hidden="true" />Enquired again</span>}
          </div>
          <Flag lead={lead} now={now} plain />
        </div>
      )}
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
