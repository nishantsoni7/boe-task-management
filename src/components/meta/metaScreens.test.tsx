/**
 * The Meta Ads screens, drawn from made-up rows (nothing from the owner's ad account belongs in this public repository),
 * and the promise that a browser can only read them.
 *
 * Run: npx tsx --test src/components/meta/metaScreens.test.tsx
 */
import '@/lib/testing/cssModuleStub'
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MetaStructure } from '@/lib/meta/api'
import { buildReport, rangeOf, syncView, type MetaAdSet, type MetaCampaign, type MetaInsight, type MetaRun } from '@/lib/meta/report'
import { CHAT_ACTION } from '@/lib/meta/results'
import { CampaignsBody } from './MetaCampaigns'
import type { MetaCtx } from './MetaScreen'
import { OverviewBody } from './MetaOverview'

const TODAY = '2026-11-02'
const now = new Date('2026-11-02T10:00:00Z')

const campaigns: MetaCampaign[] = [
  { campaign_id: '1001', name: 'Alpha Lead Ads', effective_status: 'ACTIVE', daily_budget_paise: null, lifetime_budget_paise: null },
  { campaign_id: '1002', name: 'Beta Followers', effective_status: 'PAUSED', daily_budget_paise: 15000, lifetime_budget_paise: null },
  { campaign_id: '1003', name: 'Gamma Old Push', effective_status: 'PAUSED', daily_budget_paise: null, lifetime_budget_paise: null },
]
const adSets: MetaAdSet[] = [
  { ad_set_id: '2001', campaign_id: '1001', name: 'Alpha City Chats', effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS', daily_budget_paise: 50000, lifetime_budget_paise: null },
  { ad_set_id: '2002', campaign_id: '1001', name: 'Alpha Auto Chats', effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS', daily_budget_paise: 20000, lifetime_budget_paise: null },
  { ad_set_id: '2003', campaign_id: '1001', name: 'Alpha Reel Chats', effective_status: 'PAUSED', optimization_goal: 'CONVERSATIONS', daily_budget_paise: null, lifetime_budget_paise: null },
  { ad_set_id: '2004', campaign_id: '1002', name: 'Beta Reach', effective_status: 'PAUSED', optimization_goal: 'PROFILE_VISIT', daily_budget_paise: null, lifetime_budget_paise: null },
]
const row = (adSetId: string, campaignId: string, spendRupees: number, chats: number): MetaInsight => ({
  ad_set_id: adSetId, campaign_id: campaignId, day: '2026-10-20', spend_paise: spendRupees * 100,
  actions: [{ action_type: CHAT_ACTION, value: String(chats) }],
})
const insights: MetaInsight[] = [
  row('2001', '1001', 4000, 50), row('2002', '1001', 1500, 4), row('2003', '1001', 3800, 136),
  row('2004', '1002', 1100, 19), row('9999', '1001', 700, 7),
]

const okRun: MetaRun = {
  kind: 'daily', status: 'ok', message: '', campaigns: 3, ad_sets: 4, insight_rows: 5,
  started_at: '2026-11-02T00:40:00Z', finished_at: '2026-11-02T00:41:00Z',
}

function ctxFor({ targetPaise = null, capPaise = null, canEdit = false, rows = insights, list = campaigns }: {
  targetPaise?: number | null; capPaise?: number | null; canEdit?: boolean; rows?: MetaInsight[]; list?: MetaCampaign[]
} = {}): MetaCtx {
  const structure: MetaStructure = {
    accounts: [{ account_id: '10000000000001', name: 'Test account', currency: 'INR', last_synced_at: null }],
    campaigns: list, adSets, runs: [okRun],
    settings: { monthly_cap_paise: capPaise, target_cost_per_enquiry_paise: targetPaise },
    monthSpendPaise: 120000,
  }
  return {
    structure, sync: syncView(structure.runs, now), today: TODAY, days: 30, range: rangeOf(30, TODAY), canEdit,
    accountLabel: 'Ad account 10000000000001 · Indian rupees',
    report: buildReport({ campaigns: list, adSets, insights: rows, targetPaise }),
  }
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('Overview', () => {
  test('with no target it says so, and the running ad sets are Watch or Too early', () => {
    const page = html(<OverviewBody ctx={ctxFor()} />)
    assert.ok(page.includes('Last 30 days'))
    assert.ok(page.includes('No target is set, so nothing can be called Winning or Losing yet.'))
    assert.ok(page.includes('Alpha City Chats'))
    assert.ok(page.includes('Alpha Auto Chats'))
    assert.ok(page.includes('Too early'), 'the ad set with a handful of chats')
    assert.ok(page.includes('View only'))
    assert.ok(page.includes('BOE One cannot change anything in this ad account.'))
    assert.ok(page.includes('Not set'), 'no monthly cap yet')
  })

  test('the totals add up: spend over every campaign, chats only where the goal counts them', () => {
    const page = html(<OverviewBody ctx={ctxFor()} />)
    assert.ok(page.includes('₹11,100'), 'spend 4000 + 1500 + 3800 + 1100 + 700')
    assert.ok(page.includes('>197<'), 'chats 50 + 4 + 136 + 7; the profile-visit ad set adds none')
    assert.ok(!page.includes('>216<'), 'the 19 chats on the profile-visit ad set are not counted')
  })

  test('a target turns the verdict words on, and an editor gets links to set the numbers', () => {
    const page = html(<OverviewBody ctx={ctxFor({ targetPaise: 10000, capPaise: 5000000, canEdit: true })} />)
    assert.ok(page.includes('your target of ₹100'))
    assert.ok(!page.includes('No target is set'))
    assert.ok(page.includes('href="/marketing/settings"'))
    assert.ok(page.includes('Of monthly cap used'))
  })

  test('somebody who cannot edit sees the numbers but no link to change them', () => {
    const page = html(<OverviewBody ctx={ctxFor({ targetPaise: 10000, canEdit: false })} />)
    assert.ok(!page.includes('/marketing/settings'))
  })

  test('with nothing running it says so instead of inventing a verdict', () => {
    const paused = adSets.map(a => ({ ...a, effective_status: 'PAUSED' }))
    const ctx = ctxFor()
    const quiet: MetaCtx = { ...ctx, report: buildReport({ campaigns, adSets: paused, insights, targetPaise: null }) }
    const page = html(<OverviewBody ctx={quiet} />)
    assert.ok(page.includes('Nothing running'))
    assert.ok(page.includes('No ad set is running now.'))
  })

  test('with no results at all the bars say so', () => {
    const page = html(<OverviewBody ctx={ctxFor({ rows: [] })} />)
    assert.ok(page.includes('No ad set chasing chats had delivery in this period.'))
  })
})

describe('Campaigns', () => {
  test('running campaigns come first and an unjudged goal says so', () => {
    const page = html(<CampaignsBody ctx={ctxFor()} />)
    assert.ok(page.indexOf('Alpha Lead Ads') < page.indexOf('Beta Followers'))
    assert.ok(page.includes('Another goal'))
    assert.ok(page.includes('3 of 3 campaigns'))
    assert.ok(page.includes('aria-pressed="true"'))
  })

  test('an opened campaign lists its ad sets, and the ones Meta no longer lists add up the difference', () => {
    const page = html(<CampaignsBody ctx={ctxFor()} initiallyOpen={['1001']} />)
    assert.ok(page.includes('Alpha City Chats') && page.includes('Alpha Auto Chats') && page.includes('Alpha Reel Chats'))
    assert.ok(page.includes('Ad sets Meta no longer lists'))
    assert.ok(page.includes('aria-expanded="true"'))
    assert.ok(!page.includes('Beta Reach'), 'another campaign stays closed')
  })

  test('a campaign with no delivery says so instead of showing zeros', () => {
    const page = html(<CampaignsBody ctx={ctxFor()} />)
    assert.ok(page.includes('No data'))
  })
})

describe('a browser can only read', () => {
  const SRC = process.cwd() + '/src'
  const files = [
    ...readdirSync(join(SRC, 'components/meta')).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('.test.')).map(f => join(SRC, 'components/meta', f)),
    join(SRC, 'lib/meta/api.ts'), join(SRC, 'lib/meta/report.ts'), join(SRC, 'lib/meta/verdict.ts'), join(SRC, 'hooks/useMetaAccess.ts'),
  ]
  const text = (path: string) => readFileSync(path, 'utf8')

  test('only api.ts talks to the database, and its one write is the targets function', () => {
    for (const file of files.filter(f => !f.endsWith('api.ts'))) {
      assert.ok(!/\.(from|rpc)\(/.test(text(file)), `${file} must not query the database itself`)
    }
    const api = text(join(SRC, 'lib/meta/api.ts'))
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(api), 'no write on a table')
    assert.deepEqual(api.match(/\.rpc\('[a-z_]+'/g), [".rpc('meta_set_targets'"])
  })

  test('the screens never reach Meta or the service role', () => {
    for (const file of files) {
      const code = text(file)
      assert.ok(!/graph\.facebook\.com|SUPABASE_SERVICE_ROLE_KEY|META_ACCESS_TOKEN/.test(code), file)
    }
  })
})
