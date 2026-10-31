/**
 * The For you settings on their screens (owner, 2026-10-31): the migration's
 * doors, Control Center, Account Settings, and the column reading them.
 *
 * Source-level, like the launcher's other suites. The rules themselves are
 * executed in src/lib/modules/forYouCatalogue.test.ts and forYouWork.test.ts.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270513000000_for_you_settings.sql')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
const HOOK = read('src/hooks/queries/useForYouSettings.ts')
const WORK = read('src/hooks/queries/useForYouWork.ts')
const ADMIN = read('src/components/controlCenter/ForYouSettings.tsx')
const MINE = read('src/components/modules/ForYouChoicesCard.tsx')
const ACCOUNT = read('src/app/account/page.tsx')
const SHELL = read('src/components/layout/ControlCenterLayout.tsx')

describe('the migration', () => {
  test('both tables are RLS-protected and grant nothing else', () => {
    assert.match(SQL, /alter table public\.for_you_item_settings enable row level security/)
    assert.match(SQL, /alter table public\.user_for_you_preferences enable row level security/)
  })

  test('the company setting: everyone reads, nobody writes directly', () => {
    assert.match(SQL, /grant select on public\.for_you_item_settings to authenticated;/)
    assert.equal(/create policy[^;]*for_you_item_settings[^;]*for (insert|update|delete|all)/i.test(SQL), false)
  })

  test('its one door is an active administrator, in the database', () => {
    assert.match(SQL, /security definer\s+set search_path = public, pg_temp/)
    assert.match(SQL, /u\.id = auth\.uid\(\)\s+and u\.role = 'admin'\s+and u\.is_active is true\s+and u\.is_deleted is not true/)
    assert.match(SQL, /revoke all on function public\.set_for_you_item_mode\(text, text\) from public, anon;/)
  })

  test('a person may touch only their own row, and never delete it', () => {
    assert.match(SQL, /for select to authenticated\s+using \(auth\.uid\(\) = user_id\)/)
    assert.match(SQL, /for insert to authenticated\s+with check \(auth\.uid\(\) = user_id\)/)
    assert.match(SQL, /for update to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/)
    assert.match(SQL, /grant select, insert, update on public\.user_for_you_preferences to authenticated;/)
  })

  test('it only adds', () => {
    const code = SQL.replace(/--.*$/gm, '')
    assert.equal(/\b(drop table|drop function|truncate|delete from|alter table public\.(?!for_you_item_settings|user_for_you_preferences))/i.test(code), false)
  })
})

describe('reading the settings', () => {
  test('a failed read is the defaults, so the launcher never breaks', () => {
    assert.match(HOOK, /return error \? \{ modes: \{\}, failed: true \}/)
    assert.match(HOOK, /if \(error\) return \{ hidden: \[\], failed: true \}/)
  })

  test('nothing shows until both are known', () => {
    assert.match(HOOK, /on: \(key: ForYouItemKey\) => ready && isItemOn\(key, modes, hidden\)/)
  })

  test('verifying alone is not enough: the reader must also read other people\'s payments', () => {
    assert.match(HOOK, /verifiesPayments: finance\.canApprovePayment && finance\.canViewAllFinance/)
  })

  test('a change reaches an open launcher', () => {
    assert.match(HOOK, /refetchInterval: 60_000/)
  })
})

describe('the column', () => {
  test('every kind of card asks the settings', () => {
    for (const key of ['announcement', 'pi_returned', 'leave_late', 'machine_stopped', 'cash_handed_to_you',
      'handover_waiting', 'cash_you_hold', 'cash_not_with_company']) {
      assert.ok(PANEL.includes(`on('${key}')`), `${key} is asked`)
    }
    assert.match(PANEL, /useForYouWork\(on, access\)/)
  })

  test('an item that is off costs no read', () => {
    assert.match(WORK, /const wanted = \(key: WorkItemKey\) => !!userId && !viewMode && on\(key\) && itemApplies\(key, access\)/)
    assert.match(PANEL, /useMyReturnedPis\(returnedOn\)/)
    assert.match(PANEL, /useMachineHealth\(machineOn\)/)
    assert.match(PANEL, /usePendingApprovalQueue\(userId, leaveOn\)/)
  })

  test('payment requests: pending only, newest first, not your own unless you may decide it', () => {
    assert.match(WORK, /\.eq\('status', 'pending_approval'\)/)
    assert.match(WORK, /access\.decidesOwnPayments \? pending : pending\.neq\('submitted_by', userId!\)/)
    assert.match(WORK, /\.order\('created_at', \{ ascending: false \}\)/)
  })

  test('the two personal items are read for the viewer alone', () => {
    assert.match(WORK, /\.eq\('status', 'needs_clarification'\)\s+\.eq\('submitted_by', userId!\)/)
    assert.match(WORK, /\.eq\('status', 'awaiting'\)\s+\.eq\('assigned_to', userId!\)\s+\.is\('superseded_at', null\)/)
  })

  test('new cards sit before everybody else\'s cash, and count on a phone', () => {
    const order = ['You hold {formatINR(s.held.amount)}', 's.work.map(group =>', 'Not with the company ·'].map(s => PANEL.indexOf(s))
    assert.ok(order.every(i => i >= 0))
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.match(PANEL, /const actCount = .*workCount/)
  })

  test('Clear all covers them, and five show before "N more"', () => {
    assert.match(PANEL, /group\.cards\.filter\(c => shown\(c\.key\)\)/)
    assert.match(PANEL, /\.\.\.work\.flatMap\(group => group\.cards\.map\(c => c\.key\)\)/)
    assert.match(PANEL, /cards\.slice\(0, FOR_YOU_CARDS_SHOWN\)/)
  })

  test('a failed read says so', () => {
    assert.match(PANEL, /s\.work\.some\(group => group\.failed\)/)
    assert.match(PANEL, /<ErrorCard icon=\{<Icon size=\{13\} strokeWidth=\{2\} \/>\} label=\{failedLabel\}>/)
  })

  test('the button opens Account Settings, which survives an empty panel', () => {
    assert.match(PANEL, /href=\{FOR_YOU_SETTINGS_HREF\}/)
    assert.match(MINE, /<section id="for-you"/)
  })
})

describe('Control Center', () => {
  test('is a hub of its own, with a heading and an icon', () => {
    assert.match(SHELL, /\[`\$\{MAIN_PATH\}\/for-you`\]: \{\s+title: 'For you',/)
    assert.match(SHELL, /'for-you': SlidersHorizontal/)
  })

  test('saves through the one door, and puts it back if refused', () => {
    assert.match(ADMIN, /await saveForYouMode\(key, mode\)/)
    assert.match(ADMIN, /queryClient\.setQueryData\(FOR_YOU_MODES_KEY, before\)/)
    assert.match(HOOK, /\.rpc\('set_for_you_item_mode', \{ p_item_key: key, p_mode: mode \}\)/)
  })

  test('never saves over settings it could not read', () => {
    assert.match(ADMIN, /disabled=\{unreadable \|\| saving !== null\}/)
  })
})

describe('Account Settings', () => {
  test('sits on the page, and is not offered while previewing somebody else', () => {
    assert.match(ACCOUNT, /<ForYouChoicesCard \/>/)
    assert.match(MINE, /if \(viewMode\) return null/)
  })

  test('everything offered is listed: a switch, Always on, or not part of your work', () => {
    assert.match(MINE, /const mine = offered\.filter\(item => itemApplies\(item\.key, access\)\)/)
    assert.match(MINE, /const others = offered\.filter\(item => !itemApplies\(item\.key, access\)\)/)
    assert.match(MINE, /Not part of your work/)
    assert.match(MINE, /Always on/)
  })

  test('an item the administrator turned off leaves the list', () => {
    assert.match(MINE, /FOR_YOU_ITEMS\.filter\(item => modeOf\(modes, item\.key\) !== 'off'\)/)
  })

  test('never saves over choices it could not read, and puts one back if refused', () => {
    assert.match(MINE, /\{loaded && !unreadable && \(/)
    assert.match(MINE, /queryClient\.setQueryData\(forYouChoicesKey\(userId\), before\)/)
  })
})
