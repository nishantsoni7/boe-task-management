import type { SupabaseClient } from '@supabase/supabase-js'
import { istMonthStart } from '@/lib/istDate'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import type { MetaAccount, MetaAdSet, MetaCampaign, MetaInsight, MetaRun, MetaSettings } from './report'

// The Meta Ads screens share these reads. RLS decides who gets rows: module_entry_open('marketing'). The browser
// cannot write any meta_* table; the one write is the meta_set_targets function, which checks the caller itself.

export type MetaStructure = {
  accounts: MetaAccount[]
  campaigns: MetaCampaign[]
  adSets: MetaAdSet[]
  runs: MetaRun[]
  settings: MetaSettings
  /** Spend since the first of this month, for the spending cap. */
  monthSpendPaise: number
}

const NO_SETTINGS: MetaSettings = { monthly_cap_paise: null, target_cost_per_enquiry_paise: null }

export async function fetchMetaStructure(supabase: SupabaseClient, today: string): Promise<MetaStructure> {
  const monthStart = istMonthStart(today)
  const [accounts, campaigns, adSets, month, runs, settings] = await Promise.all([
    supabase.from('meta_ad_accounts').select('account_id, name, currency, last_synced_at').order('account_id'),
    fetchAllRows<MetaCampaign>((from, to) => supabase.from('meta_campaigns')
      .select('campaign_id, name, effective_status, daily_budget_paise, lifetime_budget_paise')
      .order('campaign_id').range(from, to)),
    fetchAllRows<MetaAdSet>((from, to) => supabase.from('meta_ad_sets')
      .select('ad_set_id, campaign_id, name, effective_status, optimization_goal, daily_budget_paise, lifetime_budget_paise')
      .order('ad_set_id').range(from, to)),
    fetchAllRows<{ spend_paise: number }>((from, to) => supabase.from('meta_insights_daily')
      .select('spend_paise').gte('day', monthStart).order('ad_set_id').order('day').range(from, to)),
    supabase.from('meta_sync_runs')
      .select('kind, status, message, campaigns, ad_sets, insight_rows, started_at, finished_at')
      .order('started_at', { ascending: false }).limit(20),
    supabase.from('meta_settings').select('monthly_cap_paise, target_cost_per_enquiry_paise').maybeSingle(),
  ])
  for (const result of [accounts, runs, settings]) {
    if (result.error) throw new Error(result.error.message)
  }
  return {
    accounts: (accounts.data ?? []) as MetaAccount[],
    campaigns: unwrapPagedRows('meta campaigns', campaigns),
    adSets: unwrapPagedRows('meta ad sets', adSets),
    runs: (runs.data ?? []) as MetaRun[],
    settings: (settings.data as MetaSettings | null) ?? NO_SETTINGS,
    monthSpendPaise: unwrapPagedRows('meta month spend', month).reduce((sum, r) => sum + Number(r.spend_paise), 0),
  }
}

/** One row per ad set per day that had delivery, from `from` to `to` inclusive. */
export async function fetchMetaInsights(supabase: SupabaseClient, from: string, to: string): Promise<MetaInsight[]> {
  const result = await fetchAllRows<MetaInsight>((a, b) => supabase.from('meta_insights_daily')
    .select('ad_set_id, campaign_id, day, spend_paise, actions')
    .gte('day', from).lte('day', to).order('ad_set_id').order('day').range(a, b))
  return unwrapPagedRows('meta results', result)
}

const WRITE_MESSAGES: [RegExp, string][] = [
  [/MARKETING_FORBIDDEN/, 'You do not have access to change this.'],
  [/MARKETING_INVALID/, 'Use an amount above zero and no more than ₹1,00,00,000, or leave it empty.'],
]

/** A sentence a person can act on. The database's own code never reaches the screen. */
export function metaWriteMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return WRITE_MESSAGES.find(([code]) => code.test(message))?.[1] ?? 'Could not save. Check your connection and try again.'
}

/** Empty means "not set". Both numbers are saved together, in paise. */
export async function saveMetaTargets(supabase: SupabaseClient, capPaise: number | null, targetPaise: number | null) {
  const { error } = await supabase.rpc('meta_set_targets', { p_monthly_cap_paise: capPaise, p_target_cost_paise: targetPaise })
  if (error) throw new Error(error.message)
}
