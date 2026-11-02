/**
 * Meta's answers into rows: money in whole paise, ids that must be digits, and a row that cannot be read throws
 * instead of being half written. The figures are made up; the repository is public.
 *
 * Run: npx tsx --test src/lib/meta/parse.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  accountIdOf, budgetToPaise, parseAccount, parseAccountIds, parseAdSet, parseCampaign, parseInsight, rupeesToPaise, toCount, toIso,
} from './parse'

const NOW = '2026-11-02T03:00:00.000Z'

describe('money', () => {
  test('rupees from Meta become whole paise, with no float left over', () => {
    assert.equal(rupeesToPaise('4053.25'), 405325)
    assert.equal(rupeesToPaise('49.71'), 4971)
    assert.equal(rupeesToPaise('1585.70'), 158570)
    assert.equal(rupeesToPaise('0.29'), 29) // 0.29 * 100 is 28.999999999999996 in floating point
    assert.equal(rupeesToPaise('0'), 0)
  })

  test('an amount that is missing, negative or not a number is refused', () => {
    for (const bad of [undefined, null, '', ' ', '-1', 'abc', NaN]) assert.throws(() => rupeesToPaise(bad), /amount/, String(bad))
  })

  test('a budget is already in the smallest unit; left out means the other level holds it', () => {
    assert.equal(budgetToPaise('50000'), 50000)
    assert.equal(budgetToPaise('0'), 0)
    for (const none of [undefined, null, '']) assert.equal(budgetToPaise(none), null)
    for (const bad of ['-1', '1.5', 'x']) assert.throws(() => budgetToPaise(bad), /budget/, bad)
  })

  test('counts are whole and not negative; absent is zero', () => {
    assert.equal(toCount('1204'), 1204)
    assert.equal(toCount(undefined), 0)
    assert.throws(() => toCount('-3'), /count/)
    assert.throws(() => toCount('2.5'), /count/)
  })
})

describe('dates and ids', () => {
  test("Meta's +0530 offset is read, anything unreadable is null", () => {
    assert.equal(toIso('2026-04-12T10:22:33+0530'), '2026-04-12T04:52:33.000Z')
    assert.equal(toIso('2026-04-12T10:22:33+05:30'), '2026-04-12T04:52:33.000Z')
    for (const bad of [undefined, null, '', 'garbage', 7]) assert.equal(toIso(bad), null, String(bad))
  })

  test('an ad account id is digits only, with or without act_', () => {
    assert.equal(accountIdOf('act_1654474975008136'), '1654474975008136')
    assert.equal(accountIdOf('1654474975008136'), '1654474975008136')
    assert.throws(() => accountIdOf('act_'), /usable id/)
    assert.throws(() => accountIdOf('12'), /usable id/)
  })

  test('META_AD_ACCOUNT_IDS keeps ids and drops everything else', () => {
    assert.deepEqual(parseAccountIds('act_1654474975008136, 610017518342916 ,bad,12,'), ['1654474975008136', '610017518342916'])
    assert.deepEqual(parseAccountIds(undefined), [])
    assert.deepEqual(parseAccountIds(''), [])
  })
})

describe('rows', () => {
  test('an account', () => {
    const row = parseAccount({ account_id: '1111111', name: 'Main', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1 }, NOW)
    assert.deepEqual(row, { account_id: '1111111', name: 'Main', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1, updated_at: NOW })
  })

  test('a campaign keeps its budgets in paise and its times as instants', () => {
    const row = parseCampaign(
      { id: '2222222', name: 'Spring', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000', created_time: '2026-04-12T10:22:33+0530' },
      '1111111', NOW,
    )
    assert.equal(row.campaign_id, '2222222')
    assert.equal(row.account_id, '1111111')
    assert.equal(row.daily_budget_paise, 50000)
    assert.equal(row.lifetime_budget_paise, null)
    assert.equal(row.created_time, '2026-04-12T04:52:33.000Z')
    assert.equal(row.updated_time, null)
  })

  test('a campaign or ad set without an id throws, so the run fails instead of half writing', () => {
    assert.throws(() => parseCampaign({ name: 'x' }, '1111111', NOW), /campaign without a usable id/)
    assert.throws(() => parseAdSet({ id: '3333333', name: 'x' }, '1111111', NOW), /ad set without a usable id/)
  })

  test('names longer than the table allows are cut, not refused', () => {
    assert.equal(parseCampaign({ id: '2222222', name: 'x'.repeat(900) }, '1111111', NOW).name.length, 500)
  })

  test('an ad set carries its goal', () => {
    const row = parseAdSet({ id: '3333333', campaign_id: '2222222', name: 'Chats', optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP', daily_budget: '20000' }, '1111111', NOW)
    assert.equal(row.optimization_goal, 'CONVERSATIONS')
    assert.equal(row.destination_type, 'WHATSAPP')
    assert.equal(row.daily_budget_paise, 20000)
  })

  test('a day of results keeps only the two fields of each action', () => {
    const row = parseInsight(
      {
        adset_id: '3333333', campaign_id: '2222222', date_start: '2026-10-03', spend: '405.32', impressions: '1200', clicks: '31',
        actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4', '7d_click': '4', extra: 'x' }, { nonsense: true }],
      },
      NOW,
    )
    assert.equal(row.spend_paise, 40532)
    assert.equal(row.impressions, 1200)
    assert.equal(row.clicks, 31)
    assert.deepEqual(row.actions, [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' }])
  })

  test('a day with no actions is an empty list, and one without a date throws', () => {
    assert.deepEqual(parseInsight({ adset_id: '3333333', campaign_id: '2222222', date_start: '2026-10-03', spend: '0' }, NOW).actions, [])
    assert.throws(() => parseInsight({ adset_id: '3333333', campaign_id: '2222222', spend: '0' }, NOW), /without a date/)
  })
})
