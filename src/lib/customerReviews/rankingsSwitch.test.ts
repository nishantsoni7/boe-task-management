import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOW_RANKED, readRankingsVisible } from './rankingsSwitch'

// The review ranking switch (20270702000000): an administrator shows or hides the
// leaderboard for everyone. The rule that matters most is that it is HIDDEN unless the
// database says on. The SQL itself is executed, not read, by the PGlite rehearsal named
// in the migration's pull request; the checks here pin the screens and the SQL text.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('the switch reads as hidden unless the database says on', () => {
  test('only a stored true shows the ranking', () => {
    assert.equal(readRankingsVisible({ rankings_visible: true }), true)
    for (const v of [null, undefined, {}, [], 'true', 1, true, { rankings_visible: false }, { rankings_visible: 'true' }, { rankings_visible: 1 }, { rankings_visible: null }]) {
      assert.equal(readRankingsVisible(v), false, JSON.stringify(v))
    }
  })

  test('the hook is hidden while loading and when the read fails', () => {
    const hook = read('src/hooks/queries/useReviewRankings.ts')
    assert.match(hook, /visible: query\.data\?\.visible === true/)
    assert.match(hook, /error \? \{ visible: false, failed: true \}/)
  })
})

describe('every screen that shows the ranking obeys the switch', () => {
  const panel = read('src/components/customerReviews/ReviewsLeaderboardPanel.tsx')
  const screen = read('src/components/customerReviews/ReviewLeaderboardScreen.tsx')
  const landing = read('src/app/customer-reviews/CustomReviewsScreen.tsx')
  const credits = read('src/app/my-credits/page.tsx')

  test('the landing panel draws nothing and reads nothing while it is off', () => {
    assert.match(panel, /enabled: rankings\.visible/)
    assert.match(panel, /if \(!rankings\.visible\) return null/)
  })

  test('the ranking is the LAST thing on the Reviews landing page', () => {
    const submissions = landing.indexOf('<CustomReviewSubmissions')
    const board = landing.indexOf('<ReviewsLeaderboardPanel')
    assert.ok(submissions > 0 && board > submissions, 'the leaderboard must come after the submissions')
  })

  test('the Past months page says it is switched off instead of reading the board', () => {
    assert.match(screen, /enabled: ready && rankings\.visible/)
    assert.match(screen, /if \(!rankings\.visible\)/)
    assert.match(screen, /RANKINGS_OFF_TITLE/)
  })

  test('BOE Credits offers the leaderboard link (desktop button and phone menu) only while it is on', () => {
    assert.match(credits, /\.\.\.\(rankings\.visible \? \[\{ key: 'leaderboard'/)
    assert.match(credits, /\{rankings\.visible && \(\s*<Link href="\/my-credits\/leaderboard"/)
  })

  test('the board explains how it is ranked, in the words the team asks for', () => {
    assert.match(panel, /How is this ranked\?/)
    assert.match(HOW_RANKED.join(' '), /Equal counts share a rank/)
    assert.match(HOW_RANKED.join(' '), /not a performance score/)
  })
})

describe('Control Center › Reviews › Rankings', () => {
  test('the page exists and writes only through the admin function', () => {
    assert.match(read('src/app/admin/control-center/review-rankings/page.tsx'), /ReviewRankingsSetting/)
    const hook = read('src/hooks/queries/useReviewRankings.ts')
    assert.match(hook, /\.rpc\('set_review_rankings_visible', \{ p_visible: visible \}\)/)
    assert.doesNotMatch(hook, /\.update\(|\.upsert\(|\.insert\(/)
  })

  test('the screen will not offer a change it could not read the current state for', () => {
    assert.match(read('src/components/controlCenter/ReviewRankingsSetting.tsx'), /disabled=\{failed \|\| saving\}/)
  })
})

describe('migration 20270702000000_review_rankings_switch.sql', () => {
  const sql = read('supabase/migrations/20270702000000_review_rankings_switch.sql')

  test('it creates the one row hidden, and a second row cannot exist', () => {
    assert.match(sql, /rankings_visible\s+boolean\s+not null default false/)
    assert.match(sql, /values \(true, false\)\s+on conflict \(id\) do nothing/)
    assert.match(sql, /id\s+boolean\s+primary key default true check \(id\)/)
  })

  test('clients can read the switch and nothing else: no direct write, no anonymous read', () => {
    assert.match(sql, /alter table public\.review_display_settings enable row level security/)
    assert.match(sql, /revoke all on public\.review_display_settings from public, anon, authenticated/)
    assert.match(sql, /grant\s+select on public\.review_display_settings to authenticated/)
    assert.doesNotMatch(sql, /grant\s+(insert|update|delete|all)[^;]*review_display_settings/i)
  })

  test('the one write is an admin-only security definer function with a fixed search_path', () => {
    assert.match(sql, /create or replace function public\.set_review_rankings_visible\(p_visible boolean\)/)
    assert.match(sql, /security definer\s+set search_path = public, pg_temp/)
    assert.match(sql, /u\.role = 'admin'\s+and u\.is_active\s+and coalesce\(u\.is_deleted, false\) = false/)
    assert.match(sql, /revoke execute on function public\.set_review_rankings_visible\(boolean\) from public, anon/)
    assert.match(sql, /grant\s+execute on function public\.set_review_rankings_visible\(boolean\) to authenticated/)
  })

  test('it touches no existing review function, table or policy', () => {
    const code = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    assert.doesNotMatch(code, /customer_review/)
  })
})
