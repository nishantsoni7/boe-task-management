'use client'

import { AppLink as Link } from '@/components/ui/AppLink'
import { costPerChat, dayLabel, money, plural, rupees, rupeesWhole, type AdSetLine } from '@/lib/meta/report'
import { istMonthStart } from '@/lib/istDate'
import { LOSING_OVER_TARGET, MIN_CHATS, MIN_SPEND_PAISE, VERDICT_BADGE, VERDICT_LABEL, type Verdict } from '@/lib/meta/verdict'
import { ConnectionPanel } from './metaParts'
import { MetaScreen, type MetaCtx } from './MetaScreen'
import s from './meta.module.css'

const BAR_ROWS = 8
const OVER = Math.round((LOSING_OVER_TARGET - 1) * 100)

function runningText(ctx: MetaCtx): string {
  const { report, structure } = ctx
  const run = report.runningVerdict
  const target = structure.settings.target_cost_per_enquiry_paise
  if (!run) return 'No ad set is running now. The figures below are from the period shown.'
  const where = `${plural(report.runningCampaigns, 'campaign')} running, ${plural(run.adSets, 'ad set')} chasing chats.`
  if (run.verdict === 'too_early') return `${where} Too few chats and too little spent to judge them yet.`
  if (target === null) return `${where} No target is set, so nothing can be called Winning or Losing yet.`
  return `${where} Together they cost ${rupees(run.spendPaise / run.chats)} a chat, against your target of ${money(target)}.`
}

function barOrder(a: AdSetLine, b: AdSetLine) {
  return Number(b.running) - Number(a.running) || b.spendPaise - a.spendPaise
}

function Bars({ ctx }: { ctx: MetaCtx }) {
  const lines = ctx.report.adSets.filter(a => a.chats !== null && a.spendPaise > 0).sort(barOrder).slice(0, BAR_ROWS)
  const average = costPerChat(ctx.report.totals)
  const top = Math.max(...lines.map(a => a.costPaise ?? 0), average ?? 0, 1)
  return (
    <section className={`boe-panel ${s.panel}`} aria-labelledby="meta-bars">
      <h2 className={s.heading} id="meta-bars">Cost per chat, by ad set</h2>
      {lines.length === 0
        ? <p className={s.note}>No ad set chasing chats had delivery in this period.</p>
        : (
          <div className={s.bars}>
            {lines.map(a => {
              const width = a.costPaise === null ? 100 : Math.max((a.costPaise / top) * 100, 2)
              return (
                <div key={a.id} className={s.barRow}>
                  <div className={s.barTop}>
                    <span className={s.barName}>{a.name}</span>
                    <span className={s.barValue}>{a.costPaise === null ? 'No chats' : rupees(a.costPaise)}</span>
                  </div>
                  <div
                    className={s.track}
                    role="img"
                    aria-label={`${a.costPaise === null ? 'No chats' : `${rupees(a.costPaise)} a chat`}${average === null ? '' : `, against an average of ${rupees(average)}`}`}
                  >
                    <span className={`${s.fill}${a.running ? '' : ` ${s.fillOff}`}`} style={{ width: `${width}%` }} />
                    {average !== null && <span className={s.mark} style={{ left: `${Math.min((average / top) * 100, 100)}%` }} />}
                  </div>
                  <div className={s.barMeta}>
                    <span className={`boe-badge ${a.running ? VERDICT_BADGE[a.verdict] : 'boe-badge-pending'}`}>{a.running ? VERDICT_LABEL[a.verdict] : 'Off'}</span>
                    <span>{plural(a.chats ?? 0, 'chat')}</span>
                    <span>{rupees(a.spendPaise)} spent</span>
                    {a.running && a.budget !== '—' && <span>{a.budget}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      {average !== null && lines.length > 0 && <p className={s.legend}><i />Average {rupees(average)} a chat across all ad sets chasing chats, including ones now off</p>}
    </section>
  )
}

function NeedsNumbers({ ctx }: { ctx: MetaCtx }) {
  const { monthly_cap_paise: cap, target_cost_per_enquiry_paise: target } = ctx.structure.settings
  const action = (set: boolean, label: string) => ctx.canEdit
    ? <Link className="boe-btn boe-btn-secondary" href="/marketing/settings">{set ? 'Change' : label}</Link>
    : null
  return (
    <section className={`boe-panel ${s.panel}`} aria-labelledby="meta-needs">
      <h2 className={s.heading} id="meta-needs">Your numbers</h2>
      <div className={s.row}>
        <div><strong>Monthly spending cap</strong><span className={s.note}>{cap === null ? 'Not set. Shows spend against it on this page.' : money(cap)}</span></div>
        {action(cap !== null, 'Set cap')}
      </div>
      <div className={s.row}>
        <div><strong>Target cost per chat</strong><span className={s.note}>{target === null ? 'Not set. Until it is, ads can only be Watch or Too early.' : money(target)}</span></div>
        {action(target !== null, 'Set target')}
      </div>
    </section>
  )
}

function Rules() {
  const rule = (verdict: Verdict, text: string) => <div><span className={`boe-badge ${VERDICT_BADGE[verdict]}`}>{VERDICT_LABEL[verdict]}</span><span>{text}</span></div>
  return (
    <section className={`boe-panel ${s.panel}`} aria-labelledby="meta-rules">
      <div className={`${s.row} ${s.rowTitle}`}>
        <h2 className={s.heading} id="meta-rules">How an ad set is judged</h2>
        <span className="boe-badge boe-badge-working">Proposed, you confirm the numbers</span>
      </div>
      <div className={s.rules}>
        {rule('winning', 'Costs no more per chat than your target, with enough chats or spend to trust it.')}
        {rule('watch', `Up to ${OVER}% over your target, or no target set yet. Read again every day.`)}
        {rule('losing', `More than ${OVER}% over your target. Suggested for a look; you decide.`)}
        {rule('too_early', `Fewer than ${MIN_CHATS} chats and under ${rupeesWhole(MIN_SPEND_PAISE)} spent. Never judged on a handful of chats.`)}
      </div>
    </section>
  )
}

export function OverviewBody({ ctx }: { ctx: MetaCtx }) {
  const { report, structure, range, today } = ctx
  const { totals } = report
  const run = report.runningVerdict
  const cap = structure.settings.monthly_cap_paise
  const average = costPerChat(totals)
  const target = structure.settings.target_cost_per_enquiry_paise
  const monthStart = dayLabel(istMonthStart(today))

  return (
    <>
      <div className={`boe-panel ${s.verdict}`}>
        <span className="boe-badge boe-badge-waiting">{range.short}</span>
        {run
          ? <span className={`boe-badge ${VERDICT_BADGE[run.verdict]}`}>{VERDICT_LABEL[run.verdict]}</span>
          : <span className="boe-badge boe-badge-pending">Nothing running</span>}
        <span>{runningText(ctx)}</span>
      </div>
      <p className={s.text}>Cost per chat is the only quality signal until you tell us which chats became real enquiries.</p>

      <div className={`${s.stats} ${s.statChips}`}>
        <div className={`boe-panel ${s.stat}`}><span className={s.statValue}>{rupeesWhole(totals.spendPaise)}</span><span className={s.statLabel}>Spent</span><span className={s.note}>{range.short}</span></div>
        <div className={`boe-panel ${s.stat}`}><span className={s.statValue}>{totals.chats === null ? '—' : totals.chats.toLocaleString('en-IN')}</span><span className={s.statLabel}>Chats started</span><span className={s.note}>Messaging conversations</span></div>
        <div className={`boe-panel ${s.stat}`}><span className={s.statValue}>{average === null ? '—' : rupees(average)}</span><span className={s.statLabel}>Cost per chat</span><span className={s.note}>{target === null ? 'No target set' : `Target ${money(target)}`}</span></div>
        <div className={`boe-panel ${s.stat}`}><span className={s.statValue}>{report.runningAdSets}</span><span className={s.statLabel}>Ad sets running</span><span className={s.note}>In {plural(report.runningCampaigns, 'campaign')}</span></div>
        <div className={`boe-panel ${s.stat}`}>
          <span className={s.statValue}>{cap === null ? 'Not set' : `${Math.round((structure.monthSpendPaise / cap) * 100)}%`}</span>
          <span className={s.statLabel}>{cap === null ? 'Monthly spending cap' : 'Of monthly cap used'}</span>
          <span className={s.note}>{cap === null ? 'Set one to track spend' : `${rupeesWhole(structure.monthSpendPaise)} of ${rupeesWhole(cap)} since ${monthStart}`}</span>
        </div>
      </div>

      <div className={s.columns}>
        <Bars ctx={ctx} />
        <div className={s.tight} style={{ gap: 16 }}>
          <NeedsNumbers ctx={ctx} />
          <ConnectionPanel ctx={ctx} />
        </div>
      </div>

      <Rules />
    </>
  )
}

export function MetaOverview() {
  return (
    <MetaScreen title="Meta Ads" subtitle="What each chat from your ads costs, and which ads to keep. Read only: nothing here changes your Meta account.">
      {ctx => <OverviewBody ctx={ctx} />}
    </MetaScreen>
  )
}
