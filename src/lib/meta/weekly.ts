// What the Monday review is built on, worked out in code. Pure: the figures here are what Claude is given and all it
// may quote, so a wrong number can only come from this file, where a test can catch it.

import { istAddDays, istWeekStart } from '@/lib/istDate'
import { buildReport, money, rupees, type MetaAdSet, type MetaCampaign, type MetaInsight, type MetaSettings, type Report } from './report'
import { resultCount } from './results'
import { MIN_CHATS, MIN_SPEND_PAISE } from './verdict'

export type WeekVerdict = 'better' | 'same' | 'worse' | 'quiet'

/** Cost per chat has to move this much before the week is called Better or Worse. */
export const WEEK_MOVE_PERCENT = 10

/** The last full Monday-to-Sunday week before `today`. */
export function reviewedWeek(today: string): { start: string; end: string; previousStart: string; previousEnd: string } {
  const start = istAddDays(istWeekStart(today), -7)
  return { start, end: istAddDays(start, 6), previousStart: istAddDays(start, -7), previousEnd: istAddDays(start, -1) }
}

type Period = { spendPaise: number; chatSpendPaise: number; chats: number; costPaise: number | null; spent: string; costPerChat: string | null }

const cost = (paise: number | null) => (paise === null ? null : rupees(paise))

const period = (report: Report): Period => {
  const { spendPaise, chatSpendPaise, chats } = report.totals
  const costPaise = chats ? chatSpendPaise / chats : null
  return { spendPaise, chatSpendPaise, chats: chats ?? 0, costPaise, spent: rupees(spendPaise), costPerChat: cost(costPaise) }
}

/** Whole percent, so Claude quotes the change instead of working it out. Null when there is nothing to compare with. */
const percent = (now: number | null, before: number | null) => (now === null || !before ? null : Math.round(((now - before) / before) * 100))

export function weekVerdict(thisWeek: Period, lastWeek: Period): WeekVerdict {
  if (thisWeek.chats < MIN_CHATS && thisWeek.chatSpendPaise < MIN_SPEND_PAISE) return 'quiet'
  if (thisWeek.costPaise === null || lastWeek.costPaise === null) return 'same'
  const move = ((thisWeek.costPaise - lastWeek.costPaise) / lastWeek.costPaise) * 100
  if (move <= -WEEK_MOVE_PERCENT) return 'better'
  return move >= WEEK_MOVE_PERCENT ? 'worse' : 'same'
}

const between = (rows: MetaInsight[], from: string, to: string) => rows.filter(r => r.day >= from && r.day <= to)

export type AdSetWeek = {
  id: string; name: string; campaign: string; running: boolean; budget: string; verdict: string
  chats: number | null; spent: string; costPerChat: string | null; lastWeekChats: number | null; lastWeekCostPerChat: string | null
}
export type AdSetHistory = { id: string; name: string; campaign: string; goal: string; months: { month: string; spent: string; chats: number | null }[] }

export type WeeklyFacts = {
  week: { from: string; to: string }
  verdict: WeekVerdict
  thisWeek: Period
  lastWeek: Period
  changePercent: { spent: number | null; chats: number | null; costPerChat: number | null }
  adSets: AdSetWeek[]
  /** Running campaigns, older than the week, that spent nothing in it. */
  silentCampaigns: { id: string; name: string }[]
  history: AdSetHistory[]
  target: string | null
}

export function weeklyFacts({ campaigns, adSets, insights, settings, today }: {
  campaigns: MetaCampaign[]; adSets: MetaAdSet[]; insights: MetaInsight[]; settings: MetaSettings; today: string
}): WeeklyFacts {
  const week = reviewedWeek(today)
  const targetPaise = settings.target_cost_per_enquiry_paise
  const report = (rows: MetaInsight[]) => buildReport({ campaigns, adSets, insights: rows, targetPaise })
  const now = report(between(insights, week.start, week.end))
  const before = report(between(insights, week.previousStart, week.previousEnd))
  const campaignName = new Map(campaigns.map(c => [c.campaign_id, c.name]))
  const lastById = new Map(before.adSets.map(a => [a.id, a]))

  const weekAdSets = now.adSets
    .filter(a => a.spendPaise > 0 || (lastById.get(a.id)?.spendPaise ?? 0) > 0)
    .map(a => {
      const last = lastById.get(a.id)
      return {
        id: a.id, name: a.name, campaign: campaignName.get(a.campaignId) ?? '', running: a.running, budget: a.budget, verdict: a.verdict,
        chats: a.chats, spent: rupees(a.spendPaise), costPerChat: cost(a.costPaise),
        lastWeekChats: last?.chats ?? null, lastWeekCostPerChat: cost(last?.costPaise ?? null),
      }
    })

  const known = new Map(adSets.map(a => [a.ad_set_id, a]))
  const byAdSet = new Map<string, Map<string, { spendPaise: number; chats: number | null }>>()
  for (const row of insights) {
    const adSet = known.get(row.ad_set_id)
    if (!adSet) continue
    const months = byAdSet.get(row.ad_set_id) ?? new Map()
    byAdSet.set(row.ad_set_id, months)
    const month = months.get(row.day.slice(0, 7)) ?? { spendPaise: 0, chats: null }
    months.set(row.day.slice(0, 7), month)
    month.spendPaise += row.spend_paise
    const chats = resultCount(adSet.optimization_goal, row.actions)
    if (chats !== null) month.chats = (month.chats ?? 0) + chats
  }
  const history = [...byAdSet].map(([id, months]) => {
    const adSet = known.get(id) as MetaAdSet
    return {
      id, name: adSet.name, campaign: campaignName.get(adSet.campaign_id) ?? '', goal: adSet.optimization_goal,
      months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, spent: rupees(m.spendPaise), chats: m.chats })),
    }
  })

  const spentNow = new Set(between(insights, week.start, week.end).filter(r => r.spend_paise > 0).map(r => r.campaign_id))
  const silentCampaigns = campaigns
    .filter(c => c.effective_status === 'ACTIVE' && !spentNow.has(c.campaign_id) && (c.created_time ?? '') < week.start && !!c.created_time)
    .map(c => ({ id: c.campaign_id, name: c.name }))

  const thisWeek = period(now)
  const lastWeek = period(before)
  return {
    week: { from: week.start, to: week.end }, verdict: weekVerdict(thisWeek, lastWeek), thisWeek, lastWeek,
    changePercent: { spent: percent(thisWeek.spendPaise, lastWeek.spendPaise), chats: percent(thisWeek.chats, lastWeek.chats), costPerChat: percent(thisWeek.costPaise, lastWeek.costPaise) },
    adSets: weekAdSets, silentCampaigns, history, target: targetPaise === null ? null : money(targetPaise),
  }
}

/** What a read of the figures can be trusted for: the chats behind the ad sets a lesson cites. */
export function lessonStrength(refs: string[], facts: WeeklyFacts): 'solid' | 'fair' | 'thin' {
  const cited = new Set(refs)
  const chats = facts.history.filter(h => cited.has(h.id)).flatMap(h => h.months).reduce((sum, m) => sum + (m.chats ?? 0), 0)
  if (chats >= 100) return 'solid'
  return chats >= MIN_CHATS ? 'fair' : 'thin'
}

export type NeedDraft = { need_key: string; title: string; why: string; next_step: 'set_target' | 'set_cap' | 'learnings' | 'task' }

/** The needs rules can see. Each key stays the same week to week, so a need is one row however long it stays open. */
export function ruleNeeds(facts: WeeklyFacts, settings: MetaSettings, openLearnings: number): NeedDraft[] {
  const out: NeedDraft[] = []
  if (settings.target_cost_per_enquiry_paise === null) out.push({ need_key: 'set_target', title: 'Set a target cost per chat', why: 'Until it is set, nothing can be called Winning or Losing.', next_step: 'set_target' })
  if (settings.monthly_cap_paise === null) out.push({ need_key: 'set_cap', title: 'Set a monthly spending cap', why: 'The Overview can then show spend against it.', next_step: 'set_cap' })
  const silent = facts.silentCampaigns.length
  if (silent > 0) {
    out.push({
      need_key: 'silent_campaigns', next_step: 'task',
      title: `${silent === 1 ? 'A running campaign has' : `${silent} running campaigns have`} spent nothing for 7 days`,
      why: `Check why in Ads Manager: ${facts.silentCampaigns.map(c => c.name).join(', ')}`.slice(0, 500),
    })
  }
  if (openLearnings > 0) out.push({ need_key: 'confirm_learnings', title: `Confirm ${openLearnings === 1 ? '1 learning' : `${openLearnings} learnings`}`, why: 'Only confirmed ones are used in later reviews.', next_step: 'learnings' })
  return out
}
