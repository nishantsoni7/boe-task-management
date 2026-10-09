/**
 * Add Lead is for adding leads, and nothing else; the scoreboard lives on My
 * Leads. The promises of that split, pinned in source.
 *
 * Behaviour that needs a browser (layout, the thumb reach of the Save bar, the
 * Add bar on a phone) was checked in one at 390, 820 and 1440 px; what CI can do
 * is fail when someone removes the rules that check depended on. The logic
 * underneath is tested directly: standings.test.ts, outbox.test.ts, and the SQL
 * suites.
 *
 * Run: npx tsx --test src/components/exhibitionLeads/addLead.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const DIR = 'src/components/exhibitionLeads/'
const add = read(DIR + 'AddLeadScreen.tsx')
const list = read(DIR + 'LeadsListScreen.tsx')
const panel = read(DIR + 'StandingsPanel.tsx')
const feed = read(DIR + 'EntryFeed.tsx')
const provider = read(DIR + 'OutboxProvider.tsx')
const css = read(DIR + 'addLead.module.css')
const shell = read('src/components/layout/ExhibitionLeadsLayout.tsx')
const routeLayout = read('src/app/exhibition-leads/layout.tsx')
const hook = read('src/hooks/useExhibitionLeads.ts')
const queries = read('src/lib/exhibitionLeads/queries.ts')

/** The text of `function name(...) { ... }` up to its closing brace at the same indent. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  const end = src.indexOf('\n  }\n', start)
  return src.slice(start, end)
}

describe('Add Lead is only for adding leads', () => {
  test('no scoreboard, ranking, leaderboard, today or total on the screen', () => {
    for (const gone of ['StatTiles', 'Leaderboard', 'StandingsPanel', 'standingsQuery', 'fetchStandings', 'withMyDelta', 'boardOpen', 'exhibitionDay', 'Rank']) {
      assert.ok(!add.includes(gone), `${gone} is not on Add Lead`)
    }
    assert.doesNotMatch(add, /\/exhibition-leads\/my/, 'no tile links off to My Leads either')
  })
  test('the page is one focused column', () => {
    assert.match(css, /\.page \{ max-width: 720px; margin: 0 auto; display: flex; flex-direction: column;/)
    assert.doesNotMatch(css, /\.aside/)
    assert.doesNotMatch(css, /grid-row: 3/)
  })
  test('the form does not wait for the profile or a loading screen', () => {
    assert.doesNotMatch(add, /LoadingScreen/)
    assert.doesNotMatch(add, /if \(loading\) return/)
    assert.match(add, /useExhibitions\(supabase, true\)/, 'exhibitions are asked for at once, not after the profile')
  })
  test('the heavy sheet is still loaded only when a duplicate is opened', () => {
    assert.match(add, /dynamic\(\(\) => import\('\.\/LeadDetailSheet'\), \{ ssr: false \}\)/)
    assert.doesNotMatch(add, /^import LeadDetailSheet from/m)
  })
})

describe('the scoreboard is on My Leads', () => {
  test('Today, Total and Rank, and the leaderboard, are shown above "my" leads of one exhibition', () => {
    assert.match(list, /const showStats = mode === 'mine' && !allExhibitions && !!exhibitionId/)
    assert.match(list, /<StatTiles/)
    assert.match(list, /<Leaderboard data=\{standings\}/)
    assert.match(list, /\.\.\.standingsQuery\(supabase, exhibitionId as string\)/)
  })
  test('Today and Total are shortcuts for the date window just below them', () => {
    assert.match(list, /onToday=\{\(\) => setFilters\(\{ when: 'today' \}\)\}/)
    assert.match(list, /onTotal=\{\(\) => setFilters\(\{ when: 'all' \}\)\}/)
    assert.match(list, /activeWhen=\{state\.when\}/)
    assert.match(panel, /aria-pressed=\{activeWhen === 'today'\}/)
    assert.match(panel, /aria-pressed=\{activeWhen === 'all'\}/)
  })
  test('the numbers move at once: what is still saving is added on top', () => {
    assert.match(list, /withMyDelta\(standingsQ\.data, pending\)/)
    assert.match(list, /pendingFor\(exhibitionId\)/)
    assert.match(provider, /withMyDelta\(d, 1\)/)
    assert.match(provider, /if \(res\.outcome === 'created'\)/, 'a replay was already counted by the server')
  })
  test('the rank tile opens the board on a phone; the board is always open on a wide screen', () => {
    assert.match(panel, /aria-controls="leaderboard"/)
    assert.match(css, /@media \(min-width: 1280px\)[\s\S]*\.boardBody \{ display: block; \}/)
    assert.match(css, /\.boardOpen \.boardBody \{ display: block; \}/)
    assert.match(css, /\.topGrid \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 380px;/)
  })
  test('with no board available it shows the person\'s own numbers and no rank', () => {
    assert.match(panel, /!data \|\| data\.degraded \|\| data\.rows\.length < 2/)
    assert.match(panel, /ranked = !!me && me\.rank != null && !data\?\.degraded/)
    assert.match(queries, /degraded: true/)
  })
  test('the signed-in person is marked in words (a "You" tag), not by colour alone', () => {
    assert.match(panel, /className=\{a\.you\}>You</)
    assert.match(panel, /aria-current=\{r\.is_me \? 'true' : undefined\}/)
  })
  test('the standings read starts early on My Leads, not on Add Lead', () => {
    assert.match(queries, /if \(pathname\.startsWith\('\/exhibition-leads\/my'\)\)/)
    assert.doesNotMatch(queries, /startsWith\('\/exhibition-leads\/add'\)/)
  })
})

describe('adding is always one tap away on a phone', () => {
  test('every page but Add Lead carries a full-width red "Add Lead" bar on a phone', () => {
    assert.match(shell, /const showAddBar = !pathname\.startsWith\(`\$\{BASE\}\/add`\)/)
    assert.match(shell, /<Link href=\{`\$\{BASE\}\/add`\} className=\{a\.fab\} aria-label="Add a new lead">/)
    assert.match(css, /\.fab \{ display: none; \}/, 'hidden unless a phone')
    assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.fab \{[^}]*position: fixed;[^}]*min-height: 58px;[^}]*background: #DC1F2E/)
    assert.match(css, /safe-area-inset-bottom/)
  })
  test('the bar steps aside for a sheet and leaves room under the last row', () => {
    assert.match(css, /:global\(body\):has\(:global\(\.boe-sheet-overlay\)\) \.fab \{ display: none; \}/)
    assert.match(css, /\.fabPad \{ padding-bottom: 92px; \}/)
    assert.match(shell, /boe-page-body\$\{showAddBar \? ` \$\{a\.fabPad\}` : ''\}/)
  })
  test('in the menu, Add Lead is first and the one filled red item', () => {
    assert.match(shell, /\{ href: `\$\{BASE\}\/add`, label: 'Add Lead'/)
    assert.ok(shell.indexOf("label: 'Add Lead'") < shell.indexOf("label: 'My Leads'"))
    assert.match(shell, /const primary = item\.href === `\$\{BASE\}\/add`/)
    assert.match(shell, /background: '#DC1F2E', color: '#fff'/)
  })
  test('the module still opens on Add Lead', () => {
    assert.match(read('src/app/exhibition-leads/page.tsx'), /redirect\('\/exhibition-leads\/add'\)/)
  })
})

describe('quick to open', () => {
  test('the reads start before the module check ends, and the last exhibition list is kept', () => {
    assert.match(routeLayout, /warmStart\(qc, supabase, window\.location\.pathname\)/)
    assert.ok(routeLayout.indexOf('warmStart(') < routeLayout.indexOf('setUserId('), 'started alongside the guard')
    assert.match(hook, /initialData: \(\) => readCachedExhibitions\(\)\?\.data/)
    assert.match(queries, /cachedDefaultExhibitionId/)
  })
})

describe('quick to save', () => {
  test('Save hands the entry over and clears the form: it never waits for the network', () => {
    const submit = fn(add, 'submit')
    assert.doesNotMatch(submit, /await /, 'no await in the save path')
    assert.doesNotMatch(submit, /createLead\(/)
    assert.match(submit, /enqueue\(newEntry\(\{ id: newSubmissionId\(\)/)
    assert.match(submit, /readyForNext\(\)/)
    assert.match(fn(add, 'readyForNext'), /setValues\(emptyLeadForm\(\)\)/)
  })
  test('the idempotency key is minted once per Save, and every send of that entry reuses it', () => {
    assert.equal(add.split('newSubmissionId()').length - 1, 1, 'exactly one place mints an id')
    assert.doesNotMatch(provider, /newSubmissionId/)
    assert.match(provider, /createLead\(supabase, \{ submissionId: next\.id, exhibitionId: next\.exhibitionId, \.\.\.next\.args \}\)/)
  })
  test('the outbox is above every page, so sending carries on after the person leaves Add Lead', () => {
    assert.match(routeLayout, /<OutboxProvider userId=\{userId\}>\{children\}<\/OutboxProvider>/)
    assert.match(add, /useOutbox\(\)/)
    assert.doesNotMatch(add, /createLead|storeOutbox|loadOutbox|nextToSend/, 'Add Lead does not own the sending')
    assert.match(list, /useOutbox\(\)/)
  })
  test('entries are sent one at a time, oldest first, and a failure tries again by itself', () => {
    assert.match(provider, /if \(inFlight\.current\) return/)
    assert.match(provider, /nextToSend\(entries\)/)
    assert.match(provider, /retryDelayMs\(e\.attempts\)/)
    assert.match(provider, /addEventListener\('online'/)
  })
  test('what is owed survives a reload, per person, and is not written before it was read back', () => {
    assert.match(provider, /storeOutbox\(userId, entries\)/)
    assert.match(provider, /outboxUser === userId/)
    assert.match(provider, /loadOutbox\(userId\)/)
  })
  test('closing the tab with something still on its way asks first', () => {
    assert.match(provider, /addEventListener\('beforeunload'/)
  })
  test('Enter moves from name to mobile; the name field takes the focus after every save', () => {
    assert.match(add, /mobileRef\.current\?\.focus\(\)/)
    assert.match(add, /enterKeyHint="next" autoFocus/, 'the rebuilt form puts the cursor back in the name field')
    assert.match(add, /e\.ctrlKey \|\| e\.metaKey/, 'Ctrl/Cmd + Enter saves from a keyboard')
  })
  test('the Save bar says what is still needed, from the same list the validator uses', () => {
    assert.match(add, /missingRequired\(values\)/)
    assert.match(add, /Still needed:/)
  })
})

describe('nothing is hidden from the person', () => {
  test('every entry that needs a decision has a card with a way forward', () => {
    assert.match(feed, /Sign in again/)
    assert.match(feed, /Retry/)
    assert.match(feed, /Open existing lead/)
    assert.match(feed, /Add my note to it/)
    assert.match(feed, /Edit details/)
    assert.match(feed, /Dismiss/)
  })
  test('on My Leads, what is still sending and what needs the person are shown, with a way back to Add Lead', () => {
    assert.match(list, /<OutboxBanner entries=\{entries\} justSaved=\{justSaved\} addHref="\/exhibition-leads\/add" \/>/)
    assert.match(feed, /Review on Add Lead/)
  })
  test('the status line is a polite live region; problems are alerts', () => {
    assert.match(feed, /role="status"/)
    assert.match(feed, /role="alert"/)
  })
  test('editing an entry back into the form never silently overwrites what is being typed', () => {
    assert.match(fn(add, 'editEntry'), /window\.confirm\(/)
  })
  test('lead type keeps its words: the colour is only a second signal', () => {
    assert.match(add, /accents=\{LEAD_TYPE_ACCENTS\}/)
    const group = read(DIR + 'ChoiceGroup.tsx')
    assert.match(group, /\{accent && <span className=\{s\.accentDot\} aria-hidden="true" \/>\}/, 'the dot is decoration')
    assert.match(group, /<span className="boe-choice-text">\{o\.label\}<\/span>/, 'the label is always written beside it')
  })
})

describe('layout rules', () => {
  test('the Save bar stays in thumb reach and clears the home indicator on a phone', () => {
    assert.match(css, /\.saveBar \{\s*position: sticky; bottom: 0;/)
    assert.match(css, /safe-area-inset-bottom/)
    assert.match(css, /\.saveBtn \{[^}]*min-height: 56px/)
  })
  test('tiles are large touch targets and taps register at once', () => {
    assert.match(css, /\.tile \{[^}]*min-height: 92px/)
    assert.match(css, /touch-action: manipulation/)
    assert.match(css, /-webkit-tap-highlight-color: transparent/)
  })
  test('motion respects the reduced-motion setting', () => {
    assert.match(css, /prefers-reduced-motion: reduce/)
  })
  test('its keyframes are its own (CSS modules scope them), not borrowed from the other sheet', () => {
    assert.match(css, /@keyframes shimmer/)
    assert.doesNotMatch(css, /animation: sh /)
  })
})
