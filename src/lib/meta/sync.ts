// One read of the owner's Meta ad account into the meta_* tables: the account, its campaigns and ad sets, then the
// results per ad set per day. The first run reads as far back as Meta serves; later runs read the last 30 days
// again, because Meta settles late conversions for a few days and the upsert keeps one row per ad set per day.
//
// A failed run writes a 'failed' row and leaves every earlier row alone, so the screens keep the last good reading.

import { istAddDays, istDateOf, istToday } from '@/lib/istDate'
import { metaGet, metaGetAll } from './graph'
import { accountIdOf, parseAccount, parseAdSet, parseCampaign, parseInsight, toIso, type Json } from './parse'
import type { MetaStore } from './store'

export const STALE_RUNNING_MINUTES = 15
export const FIRST_SYNC_DAYS = 1100 // about 36 months, inside the 37 Meta keeps
export const DAILY_LOOKBACK_DAYS = 30
const WINDOW_DAYS = 90

export type SyncResult = { status: 'ok' | 'failed' | 'busy'; message: string; campaigns: number; adSets: number; insightRows: number }

type Options = { store: MetaStore; token: string; accountIds: string[]; fetchImpl?: typeof fetch; now?: Date }

/** Date ranges of at most `days` days that cover since..until with no gap and no overlap. */
export function insightWindows(since: string, until: string, days: number = WINDOW_DAYS): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = []
  for (let from = since; from <= until; from = istAddDays(from, days)) {
    const to = istAddDays(from, days - 1)
    out.push({ since: from, until: to < until ? to : until })
  }
  return out
}

export async function runMetaSync({ store, token, accountIds, fetchImpl = fetch, now = new Date() }: Options): Promise<SyncResult> {
  const stamp = now.toISOString()
  const idle = { campaigns: 0, adSets: 0, insightRows: 0 }

  if (await store.hasRunningSince(new Date(now.getTime() - STALE_RUNNING_MINUTES * 60_000).toISOString())) {
    return { status: 'busy', message: 'A sync is already running.', ...idle }
  }
  const kind = (await store.hasOkRun()) ? 'daily' : 'first'
  const runId = await store.startRun(kind)
  const counts = { ...idle }

  try {
    const today = istToday(now)

    for (const accountId of accountIds) {
      const rawAccount = await metaGet(`act_${accountId}`, { fields: 'account_id,name,currency,timezone_name,account_status,created_time' }, token, fetchImpl)
      const account = parseAccount(rawAccount, stamp)
      if (account.account_id !== accountIdOf(accountId)) throw new Error('Meta answered for a different ad account than the one asked for.')
      if (account.currency !== 'INR') {
        throw new Error(`Only rupee ad accounts are supported; this one is in ${account.currency || 'an unknown currency'}.`)
      }
      await store.upsert('meta_ad_accounts', [account], 'account_id')

      const campaigns = (await metaGetAll(
        `act_${accountId}/campaigns`,
        { fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,updated_time', limit: '200' },
        token, fetchImpl,
      )).map(raw => parseCampaign(raw as Json, accountId, stamp))
      await store.upsert('meta_campaigns', campaigns, 'campaign_id')

      const adSets = (await metaGetAll(
        `act_${accountId}/adsets`,
        { fields: 'id,campaign_id,name,status,effective_status,optimization_goal,destination_type,daily_budget,lifetime_budget,created_time,updated_time', limit: '200' },
        token, fetchImpl,
      )).map(raw => parseAdSet(raw as Json, accountId, stamp))
      await store.upsert('meta_ad_sets', adSets, 'ad_set_id')

      const floor = istAddDays(today, -(kind === 'first' ? FIRST_SYNC_DAYS : DAILY_LOOKBACK_DAYS))
      const createdIso = toIso(rawAccount.created_time)
      const created = createdIso ? istDateOf(createdIso) : null
      const since = kind === 'first' && created && created > floor ? created : floor

      let insightRows = 0
      for (const window of insightWindows(since, today)) {
        const rows = (await metaGetAll(
          `act_${accountId}/insights`,
          {
            level: 'adset',
            time_increment: '1',
            time_range: JSON.stringify(window),
            fields: 'campaign_id,adset_id,spend,impressions,clicks,actions',
            limit: '500',
          },
          token, fetchImpl,
        )).map(raw => parseInsight(raw as Json, stamp))
        await store.upsert('meta_insights_daily', rows, 'ad_set_id,day')
        insightRows += rows.length
      }

      await store.upsert('meta_ad_accounts', [{ account_id: account.account_id, last_synced_at: stamp }], 'account_id')
      counts.campaigns += campaigns.length
      counts.adSets += adSets.length
      counts.insightRows += insightRows
    }

    await store.finishRun(runId, { status: 'ok', message: '', campaigns: counts.campaigns, ad_sets: counts.adSets, insight_rows: counts.insightRows })
    return { status: 'ok', message: '', ...counts }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'The sync failed.'
    // The run row is how the screens learn it failed; if even that cannot be written there is nothing more to do.
    await store.finishRun(runId, { status: 'failed', message, campaigns: counts.campaigns, ad_sets: counts.adSets, insight_rows: counts.insightRows }).catch(() => undefined)
    return { status: 'failed', message, ...counts }
  }
}
