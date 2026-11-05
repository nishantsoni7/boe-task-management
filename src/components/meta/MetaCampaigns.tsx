'use client'

import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { plural, rupees, type Line } from '@/lib/meta/report'
import { VERDICT_BADGE, VERDICT_LABEL } from '@/lib/meta/verdict'
import { MetaScreen, type MetaCtx } from './MetaScreen'
import s from './meta.module.css'

const PAGE = 25

type Show = 'all' | 'running' | 'off'

/** `bare`: no verdict, for the line that adds up ad sets Meta no longer lists. */
function Cells({ line, bare }: { line: Line; bare?: boolean }) {
  const counted = line.chats !== null ? 'Chats started' : line.spendPaise > 0 ? 'Another goal' : '—'
  return (
    <>
      <td><span className={`${s.dot}${line.running ? ` ${s.dotOn}` : ''}`} aria-hidden="true" />{line.running ? 'Running' : 'Off'}</td>
      <td>{counted}</td>
      <td className="num">{line.chats === null ? '—' : line.chats.toLocaleString('en-IN')}</td>
      <td className="num">{line.costPaise === null ? '—' : rupees(line.costPaise)}</td>
      <td>{line.budget}</td>
      <td className="num">{rupees(line.spendPaise)}</td>
      <td>{bare ? <span className={s.mut}>—</span> : <span className={`boe-badge ${VERDICT_BADGE[line.verdict]}`}>{VERDICT_LABEL[line.verdict]}</span>}</td>
    </>
  )
}

export function CampaignsBody({ ctx, initiallyOpen = [] }: { ctx: MetaCtx; initiallyOpen?: string[] }) {
  const { report } = ctx
  const [show, setShow] = useState<Show>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(initiallyOpen))
  const [limit, setLimit] = useState(PAGE)

  const running = report.campaigns.filter(c => c.running).length
  const needle = query.trim().toLowerCase()
  const matches = report.campaigns.filter(c =>
    (show === 'all' || (show === 'running') === c.running) && (needle === '' || c.name.toLowerCase().includes(needle)))
  const shown = matches.slice(0, limit)

  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const choose = (next: Show) => { setShow(next); setLimit(PAGE) }
  const chip = (value: Show, label: string, count: number) => (
    <button type="button" className={`${s.chip}${show === value ? ` ${s.chipOn}` : ''}`} aria-pressed={show === value} onClick={() => choose(value)}>
      {label} <b>{count}</b>
    </button>
  )

  return (
    <>
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          <div className={s.chips} role="group" aria-label="Show campaigns">
            {chip('all', 'All', report.campaigns.length)}
            {chip('running', 'Running', running)}
            {chip('off', 'Off', report.campaigns.length - running)}
          </div>
          <input
            className={`boe-input ${s.search}`} type="search" placeholder="Search campaigns" aria-label="Search campaigns"
            value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE) }}
          />
        </div>
      </div>

      <div className="boe-callout boe-callout-info" role="note">
        <Info aria-hidden="true" />
        <span>A campaign is only judged on the result it was set up to chase. One aimed at something other than chats, such as profile visits, gets no verdict.</span>
      </div>

      <div className="boe-table-wrap">
        {/* A phone: one card per campaign (and per ad set when it is opened); nothing scrolls sideways. */}
        <PhoneTableCards className={`${s.tableScroll} ${s.campaignCards} p3-cardgrid`}>
          <table className="boe-table">
            <thead>
              <tr>
                <th scope="col">Campaign and ad sets</th>
                <th scope="col">Delivery</th>
                <th scope="col">Result counted</th>
                <th scope="col" className="num">Results</th>
                <th scope="col" className="num">Cost per result</th>
                <th scope="col">Budget</th>
                <th scope="col" className="num">Spent</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => {
                const isOpen = open.has(c.id)
                const children = [...c.adSets.map(line => ({ line, bare: false })), ...(c.unlisted ? [{ line: c.unlisted, bare: true }] : [])]
                return (
                  <Fragment key={c.id}>
                    <tr>
                      <td>
                        <button type="button" className={s.expand} aria-expanded={isOpen} onClick={() => toggle(c.id)}>
                          {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                          <span className={s.cname}>{c.name}</span>
                        </button>
                      </td>
                      <Cells line={c} />
                    </tr>
                    {isOpen && children.length === 0 && (
                      <tr className={s.child}><td colSpan={8}><span className={s.mut}>No ad set had delivery in this period.</span></td></tr>
                    )}
                    {isOpen && children.map(({ line, bare }, i) => (
                      <tr key={line.id} className={`${s.child}${i < children.length - 1 ? ` ${s.childMore}` : ''}`}>
                        <td><span className={s.cname}>{line.name}</span></td>
                        <Cells line={line} bare={bare} />
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
              {shown.length === 0 && <tr><td colSpan={8}><div className="boe-empty">No campaigns match.</div></td></tr>}
            </tbody>
          </table>
        </PhoneTableCards>
        <div className={s.footNote}>
          <span>{shown.length} of {plural(matches.length, 'campaign')}. Running first, then by spend.</span>
          {matches.length > shown.length && <button type="button" className="boe-btn boe-btn-text" onClick={() => setLimit(l => l + PAGE)}>Load more</button>}
        </div>
      </div>
    </>
  )
}

export function MetaCampaigns() {
  return (
    <MetaScreen title="Campaigns" subtitle="Open a campaign to see its ad sets. Read only: nothing here changes your Meta account.">
      {ctx => <CampaignsBody ctx={ctx} />}
    </MetaScreen>
  )
}
