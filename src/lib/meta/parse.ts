// Meta's answers, turned into the rows of supabase/migrations/20270522000100_meta_ads_tables.sql.
//
// Money is whole paise. Meta sends spend as a decimal string in rupees and budgets as an integer in the account
// currency's smallest unit; the sync refuses any account whose currency is not INR, so both are paise here.
// A row Meta sends without a usable id throws: the run then fails loudly, which is how a change in Meta's shape is
// noticed, instead of half a table being written.

export type Json = Record<string, unknown>
export type Action = { action_type: string; value: string }

export type AccountRow = {
  account_id: string
  name: string
  currency: string
  timezone_name: string
  account_status: number | null
  updated_at: string
}

export type CampaignRow = {
  campaign_id: string
  account_id: string
  name: string
  objective: string
  status: string
  effective_status: string
  daily_budget_paise: number | null
  lifetime_budget_paise: number | null
  created_time: string | null
  updated_time: string | null
  updated_at: string
}

export type AdSetRow = {
  ad_set_id: string
  campaign_id: string
  account_id: string
  name: string
  status: string
  effective_status: string
  optimization_goal: string
  destination_type: string
  daily_budget_paise: number | null
  lifetime_budget_paise: number | null
  created_time: string | null
  updated_time: string | null
  updated_at: string
}

export type InsightRow = {
  ad_set_id: string
  day: string
  campaign_id: string
  spend_paise: number
  impressions: number
  clicks: number
  actions: Action[]
  updated_at: string
}

const ID = /^[0-9]{5,25}$/
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

function id(value: unknown, what: string): string {
  const s = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!ID.test(s)) throw new Error(`Meta sent ${what} without a usable id.`)
  return s
}

/** "4053.25" is 405325 paise. Throws on anything that is not a non-negative number. */
export function rupeesToPaise(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n < 0) throw new Error('Meta sent an amount this app cannot read.')
  return Math.round(n * 100)
}

/** A budget in the currency's smallest unit; Meta leaves it out when the budget sits on the other level. */
export function budgetToPaise(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Meta sent a budget this app cannot read.')
  return n
}

export function toCount(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Meta sent a count this app cannot read.')
  return n
}

/** Meta writes offsets as +0530; Postgres and Date want +05:30. Anything unreadable becomes null. */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  const date = new Date(value.replace(/([+-][0-9]{2})([0-9]{2})$/, '$1:$2'))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Meta's ids come as "act_123" on the account edge and plain "123" in `account_id`. */
export function accountIdOf(value: unknown): string {
  return id(typeof value === 'string' ? value.replace(/^act_/, '') : value, 'an ad account')
}

/** META_AD_ACCOUNT_IDS: comma separated, with or without act_. Anything that is not an id is dropped. */
export function parseAccountIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(part => part.trim().replace(/^act_/, ''))
    .filter(part => ID.test(part))
}

export function parseAccount(raw: Json, now: string): AccountRow {
  return {
    account_id: accountIdOf(raw.account_id ?? raw.id),
    name: text(raw.name, 300),
    currency: text(raw.currency, 8),
    timezone_name: text(raw.timezone_name, 80),
    account_status: Number.isInteger(raw.account_status) ? (raw.account_status as number) : null,
    updated_at: now,
  }
}

export function parseCampaign(raw: Json, accountId: string, now: string): CampaignRow {
  return {
    campaign_id: id(raw.id, 'a campaign'),
    account_id: accountId,
    name: text(raw.name, 500),
    objective: text(raw.objective, 80),
    status: text(raw.status, 40),
    effective_status: text(raw.effective_status, 40),
    daily_budget_paise: budgetToPaise(raw.daily_budget),
    lifetime_budget_paise: budgetToPaise(raw.lifetime_budget),
    created_time: toIso(raw.created_time),
    updated_time: toIso(raw.updated_time),
    updated_at: now,
  }
}

export function parseAdSet(raw: Json, accountId: string, now: string): AdSetRow {
  return {
    ad_set_id: id(raw.id, 'an ad set'),
    campaign_id: id(raw.campaign_id, 'an ad set'),
    account_id: accountId,
    name: text(raw.name, 500),
    status: text(raw.status, 40),
    effective_status: text(raw.effective_status, 40),
    optimization_goal: text(raw.optimization_goal, 80),
    destination_type: text(raw.destination_type, 80),
    daily_budget_paise: budgetToPaise(raw.daily_budget),
    lifetime_budget_paise: budgetToPaise(raw.lifetime_budget),
    created_time: toIso(raw.created_time),
    updated_time: toIso(raw.updated_time),
    updated_at: now,
  }
}

export function parseInsight(raw: Json, now: string): InsightRow {
  const day = typeof raw.date_start === 'string' ? raw.date_start : ''
  if (!DAY.test(day)) throw new Error('Meta sent a result without a date.')
  const actions = Array.isArray(raw.actions) ? raw.actions : []
  return {
    ad_set_id: id(raw.adset_id, 'a result'),
    day,
    campaign_id: id(raw.campaign_id, 'a result'),
    spend_paise: rupeesToPaise(raw.spend),
    impressions: toCount(raw.impressions),
    clicks: toCount(raw.clicks),
    // Only the two fields we read, so a change in what Meta adds never reaches the table.
    actions: actions
      .filter((a): a is Json => typeof a === 'object' && a !== null && typeof (a as Json).action_type === 'string')
      .map(a => ({ action_type: String(a.action_type), value: String(a.value ?? '0') })),
    updated_at: now,
  }
}
