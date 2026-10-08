/**
 * The Add Lead screen — the promises of the redesign, pinned in source.
 *
 * Behaviour that needs a browser (layout, the thumb reach of the Save bar) was
 * checked in one at 390, 768 and 1440 px; what CI can do is fail when someone
 * removes the rules that check depended on. The logic underneath is tested
 * directly: standings.test.ts, outbox.test.ts, and the SQL suites.
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
const panel = read(DIR + 'StandingsPanel.tsx')
const feed = read(DIR + 'EntryFeed.tsx')
const css = read(DIR + 'addLead.module.css')
const layout = read('src/app/exhibition-leads/layout.tsx')
const hook = read('src/hooks/useExhibitionLeads.ts')
const queries = read('src/lib/exhibitionLeads/queries.ts')

/** The text of `function name(...) { ... }` up to its closing brace at the same indent. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  const end = src.indexOf('\n  }\n', start)
  return src.slice(start, end)
}

describe('quick to open', () => {
  test('the form does not wait for the profile or a loading screen', () => {
    assert.doesNotMatch(add, /LoadingScreen/)
    assert.doesNotMatch(add, /if \(loading\) return/)
    assert.match(add, /useExhibitions\(supabase, true\)/, 'exhibitions are asked for at once, not after the profile')
  })
  test('the reads start before the module check ends, and the last exhibition list is kept', () => {
    assert.match(layout, /warmStart\(qc, supabase, window\.location\.pathname\)/)
    assert.ok(layout.indexOf('warmStart(') < layout.indexOf('setSignedIn(true)'), 'started alongside the guard')
    assert.match(hook, /initialData: \(\) => readCachedExhibitions\(\)\?\.data/)
    assert.match(queries, /if \(pathname\.startsWith\('\/exhibition-leads\/add'\)\)/, 'only this page pays for the standings read')
    assert.match(queries, /cachedDefaultExhibitionId/)
  })
  test('the screen and the early start ask for the same thing under the same key', () => {
    assert.match(add, /\.\.\.standingsQuery\(supabase, exhibitionId as string\)/)
    assert.match(queries, /queryKey: standingsKey\(exhibitionId\)/)
    assert.match(add, /standingsKey\(next\.exhibitionId\)/)
  })
  test('the heavy sheet is still loaded only when a duplicate is opened', () => {
    assert.match(add, /dynamic\(\(\) => import\('\.\/LeadDetailSheet'\), \{ ssr: false \}\)/)
    assert.doesNotMatch(add, /^import LeadDetailSheet from/m)
  })
})

describe('quick to save', () => {
  test('Save hands the entry over and clears the form: it never waits for the network', () => {
    const submit = fn(add, 'submit')
    assert.doesNotMatch(submit, /await /, 'no await in the save path')
    assert.doesNotMatch(submit, /createLead\(/)
    assert.match(submit, /newEntry\(\{ id: newSubmissionId\(\)/)
    assert.match(submit, /readyForNext\(\)/)
    assert.match(fn(add, 'readyForNext'), /setValues\(emptyLeadForm\(\)\)/)
  })
  test('the idempotency key is minted once per Save, and every send of that entry reuses it', () => {
    assert.equal(add.split('newSubmissionId()').length - 1, 1, 'exactly one place mints an id')
    assert.match(add, /createLead\(supabase, \{ submissionId: next\.id, exhibitionId: next\.exhibitionId, \.\.\.next\.args \}\)/)
  })
  test('entries are sent one at a time, oldest first, and a failure tries again by itself', () => {
    assert.match(add, /if \(inFlight\.current\) return/)
    assert.match(add, /nextToSend\(entries\)/)
    assert.match(add, /retryDelayMs\(e\.attempts\)/)
    assert.match(add, /addEventListener\('online'/)
  })
  test('what is owed survives a reload, per person, and is not written before it was read back', () => {
    assert.match(add, /storeOutbox\(userId, entries\)/)
    assert.match(add, /outboxUser === userId/)
    assert.match(add, /loadOutbox\(userId\)/)
  })
  test('closing the tab with something still on its way asks first', () => {
    assert.match(add, /addEventListener\('beforeunload'/)
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

describe('where I stand', () => {
  test('Today and Total are links to My Leads, Total across all days', () => {
    assert.match(add, /myLeadsHref="\/exhibition-leads\/my"/)
    assert.match(add, /totalHref=\{`\/exhibition-leads\/my\?\$\{exParam\}when=all`\}/)
    assert.match(panel, /<Link href=\{myLeadsHref\}/)
    assert.match(panel, /<Link href=\{totalHref\}/)
  })
  test('the numbers move at once: what is still saving is added on top, and a confirmed save is added to the cache', () => {
    assert.match(add, /withMyDelta\(standingsQ\.data, pending\)/)
    assert.match(add, /withMyDelta\(d, 1\)/)
    assert.match(add, /if \(res\.outcome === 'created'\)/, 'a replay was already counted by the server')
  })
  test('the rank tile opens the board on a phone; the board is always open on a wide screen', () => {
    assert.match(panel, /aria-controls="leaderboard"/)
    assert.match(css, /@media \(min-width: 1280px\)[\s\S]*\.boardBody \{ display: block; \}/)
    assert.match(css, /\.boardOpen \.boardBody \{ display: block; \}/)
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
  test('phone first: one column in the order tiles → board → form → recent', () => {
    for (const [cls, order] of [['head', 1], ['stats', 2], ['board', 3], ['main', 4], ['recent', 5]] as const) {
      assert.match(css, new RegExp(`\\.${cls} \\{ order: ${order}; \\}`), cls)
    }
    assert.match(css, /\.aside \{ display: contents; \}/)
  })
  test('wide screens place every part in an explicit cell, so `order` cannot misplace them', () => {
    assert.match(css, /@media \(min-width: 1280px\)/)
    for (const cell of ['.head { grid-column: 1 / -1; grid-row: 1; }', '.stats { grid-column: 1 / -1; grid-row: 2; }',
      '.main { grid-column: 1; grid-row: 3; }', 'grid-column: 2; grid-row: 3;']) {
      assert.ok(css.includes(cell), cell)
    }
  })
  test('the Save bar stays in thumb reach and clears the home indicator on a phone', () => {
    assert.match(css, /\.saveBar \{\s*position: sticky; bottom: 0;/)
    assert.match(css, /safe-area-inset-bottom/)
    assert.match(css, /\.saveBtn \{[^}]*min-height: 56px/)
  })
  test('tiles are 44px+ touch targets and taps register at once', () => {
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
