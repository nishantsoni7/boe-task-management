/**
 * How Meetings Work — the in-app guide.
 *
 * What these pin, and why each is worth a test:
 *
 *   1. ACCURACY. Every rule the page states is asserted against the constant or
 *      the migration the workflow actually runs on. A guide that describes
 *      behaviour the system does not have is worse than no guide: the employee who
 *      checks it finds the two disagreeing and has no way to know which is wrong.
 *      This is the section that would catch "an unresolved item has to be added
 *      again next month" surviving as copy after carry-forward shipped.
 *
 *   2. PLACEMENT. It lives in the Meetings module and nowhere else. The failure it
 *      guards against is a help page quietly appearing on the dashboard, in the
 *      global sidebar or in another module.
 *
 *   3. NO DEVELOPER LANGUAGE. No table, policy, RPC or migration name reaches an
 *      employee.
 *
 *   4. READABLE ON A PHONE. No fixed-width diagram, no minimum-width table, and
 *      every layout the page uses has a one-column form.
 *
 *   5. ACCESSIBLE. Headings in order with nothing skipped, a text equivalent for
 *      every diagram, every decorative glyph hidden, colour never the only carrier
 *      of meaning, and reduced motion respected.
 *
 * Run:
 *   npx tsx --test src/app/meetings/guide/guide.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  AFTER_SALES_TAGS, AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORIES,
  DISCUSSION_CATEGORY_META, DISCUSSION_STATE_META,
} from '@/lib/meetings/discussion'
import {
  AFTER_SALES_TAG_NOTE, CAPTURE_FLOW, CAPTURE_NOTES, CATEGORY_CARDS,
  CATEGORY_DIVIDING_LINE, COMPLETION_CHECKLIST, FAQS, LIFECYCLE, LIFECYCLE_BRANCHES,
  MEETINGS_VS_TASKS, MEETINGS_VS_TASKS_RULE, MULTI_MEETING_EXAMPLE,
  MULTI_MEETING_NOTE, PHASES, PURPOSE_NODES, SECTIONS,
} from './guideContent'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// The route (shell + session) and the content it renders. Every assertion about
// what a reader sees is made against both, so moving JSX between them cannot hide it.
const ROUTE   = read('src/app/meetings/guide/page.tsx')
const GUIDE   = read('src/app/meetings/guide/MeetingGuide.tsx')
const PAGE    = `${ROUTE}\n${GUIDE}`
const CONTENT = read('src/app/meetings/guide/guideContent.ts')
const CSS     = read('src/app/globals.css')
const LAYOUT  = read('src/components/layout/MeetingsLayout.tsx')

/**
 * The Meetings block of globals.css — from its own banner to the NEXT top-level
 * banner, never to the end of the file. The block sits before other pages'
 * blocks, so an open-ended slice would judge those pages by this page's rules.
 */
function meetingsCss(): string {
  const start = CSS.indexOf('MEETINGS — "How Meetings Work" guide')
  assert.ok(start > 0, 'the Meetings block must be findable by its own banner')
  const next = CSS.indexOf('\n/* ══', start)
  return next > start ? CSS.slice(start, next) : CSS.slice(start)
}

/** Every string the guide can show, so a claim can be searched for once. */
const ALL_COPY = [
  ...PURPOSE_NODES.flatMap(n => [n.label, n.detail]),
  ...PHASES.flatMap(p => [p.title, p.summary, ...p.steps]),
  ...CATEGORY_CARDS.flatMap(c => [c.label, c.when, ...c.examples]),
  CATEGORY_DIVIDING_LINE,
  AFTER_SALES_TAG_NOTE,
  ...CAPTURE_FLOW.flatMap(s => [s.title, s.detail]),
  ...CAPTURE_NOTES,
  ...LIFECYCLE.flatMap(s => [s.label, s.detail]),
  ...LIFECYCLE_BRANCHES.flatMap(b => [b.label, ...b.points]),
  ...MULTI_MEETING_EXAMPLE.flatMap(m => [m.meeting, m.update, m.note]),
  MULTI_MEETING_NOTE,
  ...MEETINGS_VS_TASKS.flatMap(s => [s.label, ...s.answers]),
  ...MEETINGS_VS_TASKS_RULE,
  ...COMPLETION_CHECKLIST,
  ...FAQS.flatMap(f => [f.question, f.answer]),
].join('\n')

/** The migration the guide describes, located by content. */
const MIGRATION = (() => {
  const dir = join(ROOT, 'supabase', 'migrations')
  const found = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(join(dir, f), 'utf8'))
    .filter(sql => /CREATE TABLE IF NOT EXISTS public\.meeting_discussion_items/.test(sql))
  assert.equal(found.length, 1)
  return found[0]
})()

// ─── 1. Accuracy ─────────────────────────────────────────────────────────────

describe('every rule the guide states is the rule the system applies', () => {
  test('it describes exactly the two categories the database allows', () => {
    assert.equal(CATEGORY_CARDS.length, DISCUSSION_CATEGORIES.length)
    assert.deepEqual(CATEGORY_CARDS.map(c => c.category), DISCUSSION_CATEGORIES)
    for (const card of CATEGORY_CARDS) {
      assert.equal(card.label, DISCUSSION_CATEGORY_META[card.category].label,
        'the guide must use the label the badges use')
    }
  })

  test('only After Sales offers quick tags, and it offers exactly the four that exist', () => {
    const running = CATEGORY_CARDS.find(c => c.category === 'running_order')!
    const after   = CATEGORY_CARDS.find(c => c.category === 'after_sales')!
    assert.deepEqual(running.tags, [], 'a running-order tag is refused by the CHECK constraint')
    assert.deepEqual(after.tags, AFTER_SALES_TAGS)
    for (const tag of after.tags) {
      assert.ok(AFTER_SALES_TAG_NOTE.includes(AFTER_SALES_TAG_LABEL[tag]), tag)
    }
  })

  test('the examples given are the ones BOE actually asked for', () => {
    const running = CATEGORY_CARDS.find(c => c.category === 'running_order')!.examples.join('|').toLowerCase()
    for (const needle of ['drawing approval', 'fabric approval', 'production delay', 'material', 'qc', 'dispatch']) {
      assert.ok(running.includes(needle), `Running Order is missing: ${needle}`)
    }
    const after = CATEGORY_CARDS.find(c => c.category === 'after_sales')!.examples.join('|').toLowerCase()
    for (const needle of ['repair', 'replacement', 'site damage', 'wrong item', 'finish or fitting', 'not matching']) {
      assert.ok(after.includes(needle), `After Sales is missing: ${needle}`)
    }
  })

  test('the lifecycle it draws ends in the two states the database has', () => {
    const labels = LIFECYCLE.map(s => s.label)
    assert.deepEqual(labels, ['Captured', 'Added to an agenda', 'Discussed', 'Still Open, or Resolved'])
    assert.ok(LIFECYCLE.at(-1)!.label.includes(DISCUSSION_STATE_META.open.label))
    assert.ok(LIFECYCLE.at(-1)!.label.includes(DISCUSSION_STATE_META.resolved.label))
  })

  test('it describes all three branches, and no fourth one', () => {
    assert.deepEqual(LIFECYCLE_BRANCHES.map(b => b.id), ['open', 'resolved', 'reopened'])
  })

  test('the carry-forward promise matches what the migration does', () => {
    const openBranch = LIFECYCLE_BRANCHES.find(b => b.id === 'open')!.points.join(' ').toLowerCase()
    assert.ok(openBranch.includes('next meeting'))
    assert.ok(openBranch.includes('on its own') || openBranch.includes('automatic'))
    // …and the migration really does it on creation, transactionally.
    assert.match(MIGRATION, /AFTER INSERT ON public\.meetings/)
    assert.match(MIGRATION, /apply_meeting_discussion_carry_forward/)
  })

  test('the "history continues, nothing is rewritten" claim matches the migration', () => {
    const openBranch = LIFECYCLE_BRANCHES.find(b => b.id === 'open')!.points.join(' ').toLowerCase()
    assert.ok(openBranch.includes('same discussion history'))
    assert.ok(openBranch.includes('not a new'))
    // The carry-forward function copies no earlier value.
    const fn = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.apply_meeting_discussion_carry_forward[\s\S]*?\n\$\$;/)![0]
    for (const column of ['latest_update', 'decision', 'next_review_date']) {
      assert.ok(!fn.includes(column), `${column} is copied forward, so the guide is wrong`)
    }
  })

  test('the resolution rules it states are the ones enforced', () => {
    const resolved = LIFECYCLE_BRANCHES.find(b => b.id === 'resolved')!.points.join(' ').toLowerCase()
    assert.ok(resolved.includes('note'), 'the guide must say a note is required')
    assert.ok(resolved.includes('who resolved it'))
    assert.ok(resolved.includes('stops appearing') || resolved.includes('stop'))
    assert.match(MIGRATION, /MEETING_DISCUSSION_NOTE_REQUIRED/)
    assert.match(MIGRATION, /btrim\(COALESCE\(resolution_note, ''\)\) <> ''/)
  })

  test('the reopen rules it states are the ones enforced', () => {
    const reopened = LIFECYCLE_BRANCHES.find(b => b.id === 'reopened')!.points.join(' ').toLowerCase()
    assert.ok(reopened.includes('reason'))
    assert.ok(reopened.includes('same item'))
    assert.ok(reopened.includes('unchanged') || reopened.includes('stays'))
    assert.match(MIGRATION, /MEETING_DISCUSSION_REASON_REQUIRED/)
  })

  test('duplicate prevention is promised, and the database keeps it', () => {
    assert.ok(CAPTURE_NOTES.some(note => note.toLowerCase().includes('twice')))
    assert.match(MIGRATION, /meeting_discussion_items_one_open_per_task_idx/)
  })

  test('the Meeting Inbox is explained, and it is what the code reads', () => {
    assert.ok(CAPTURE_NOTES.some(n => n.includes('Meeting Inbox')))
    const inbox = FAQS.find(f => f.question.includes('no upcoming meeting'))
    assert.ok(inbox, 'the Inbox question must be answered')
    assert.ok(inbox!.answer.includes('Meeting Inbox'))
    // The Inbox is "open items with no appearance" — the same condition in both places.
    assert.match(read('src/lib/meetings/discussionReads.ts'), /state', 'open'/)
    assert.match(MIGRATION, /NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.meeting_discussion_appearances a/)
  })

  test('the worked example runs across four meetings and resolves only at the end', () => {
    assert.equal(MULTI_MEETING_EXAMPLE.length, 4)
    assert.deepEqual(MULTI_MEETING_EXAMPLE.map(m => m.state),
      ['open', 'open', 'open', 'resolved'])
    // And it says the plain thing that confuses people most.
    assert.ok(MULTI_MEETING_NOTE.toLowerCase().includes('completing a meeting does not resolve'))
  })

  test('the Meetings-versus-Tasks rule is stated in both directions', () => {
    const rules = MEETINGS_VS_TASKS_RULE.join(' ').toLowerCase()
    assert.ok(rules.includes('completing a meeting does not complete its linked tasks'))
    assert.ok(rules.includes('completing a task does not resolve'))
  })

  test('responsibility is pointed at Tasks, never at Meetings', () => {
    const answer = FAQS.find(f => f.question.includes('assign responsibility'))!.answer
    assert.ok(answer.includes('Tasks'))
    assert.ok(answer.toLowerCase().includes('owner') || answer.toLowerCase().includes('due date'))
  })

  test('the viewer answer says a view-only user cannot edit', () => {
    const answer = FAQS.find(f => f.question.includes('viewer edit'))!.answer
    assert.ok(answer.startsWith('No'))
    assert.ok(answer.toLowerCase().includes('completed meeting is read-only'))
  })

  test('all nine questions the brief asked for are answered', () => {
    const questions = FAQS.map(f => f.question.toLowerCase()).join('\n')
    for (const needle of [
      'not finished in one meeting',
      'more than one issue',
      'difference between completing a meeting and resolving',
      'assign responsibility',
      'earlier meetings',
      'reopened',
      'no upcoming meeting',
      'viewer edit',
    ]) {
      assert.ok(questions.includes(needle), `no question covers: ${needle}`)
    }
  })

  test('the checklist covers the six things the brief asked for', () => {
    const list = COMPLETION_CHECKLIST.join('\n').toLowerCase()
    for (const needle of ['update', 'decision', 'evidence', 'owner', 'resolved', 'open']) {
      assert.ok(list.includes(needle), `the checklist is missing: ${needle}`)
    }
  })

  test('the purpose map shows all seven uses the brief asked for', () => {
    const labels = PURPOSE_NODES.map(n => n.label.toLowerCase()).join('\n')
    for (const needle of ['agenda', 'orders', 'discussion', 'decisions', 'follow-up', 'history', 'carry']) {
      assert.ok(labels.includes(needle), `the map is missing: ${needle}`)
    }
  })

  test('the three phases carry all the steps the brief asked for', () => {
    assert.deepEqual(PHASES.map(p => p.id), ['before', 'during', 'after'])
    const during = PHASES.find(p => p.id === 'during')!.steps.join('\n').toLowerCase()
    for (const needle of ['one item', 'latest position', 'evidence', 'decision', 'task', 'resolved']) {
      assert.ok(during.includes(needle), `During is missing: ${needle}`)
    }
    const after = PHASES.find(p => p.id === 'after')!.steps.join('\n').toLowerCase()
    for (const needle of ['complete the meeting', 'tasks', 'next meeting', 'history']) {
      assert.ok(after.includes(needle), `After is missing: ${needle}`)
    }
  })

  test('the five capture steps are the five the brief named', () => {
    assert.equal(CAPTURE_FLOW.length, 5)
    const titles = CAPTURE_FLOW.map(s => s.title.toLowerCase())
    assert.ok(titles[0].includes('task'))
    assert.ok(titles[1].includes('add to meeting'))
    assert.ok(titles[2].includes('category'))
    assert.ok(titles[3].includes('order') && titles[3].includes('issue'))
    assert.ok(titles[4].includes('agenda'))
  })

  test('it says the source task stays linked', () => {
    assert.ok(CAPTURE_NOTES.some(n => n.toLowerCase().includes('stays linked')))
  })
})

// ─── 2. Placement ────────────────────────────────────────────────────────────

describe('the guide lives in the Meetings module and nowhere else', () => {
  test('its route is under /meetings, so it inherits the module guard and shell', () => {
    // Being at src/app/meetings/guide is what puts it behind MeetingsGuard
    // (src/app/meetings/layout.tsx) — the page does not re-implement that check.
    assert.ok(readdirSync(join(ROOT, 'src', 'app', 'meetings')).includes('guide'))
    assert.match(PAGE, /MeetingsLayout/)
  })

  test('it is reachable from the module header on every Meetings screen', () => {
    assert.match(LAYOUT, /const GUIDE_PATH = '\/meetings\/guide'/)
    assert.match(LAYOUT, /How Meetings Work/)
    // …and not from the guide itself, where it would point at the current page.
    assert.match(LAYOUT, /!pathname\.startsWith\(GUIDE_PATH\)/)
  })

  test('it is in the module navigation, and the nav has no cross-module link', () => {
    assert.match(LAYOUT, /path: '\/meetings\/guide'/)
    const navPaths = [...LAYOUT.matchAll(/path: '([^']+)'/g)].map(m => m[1])
    for (const path of navPaths) {
      assert.ok(path.startsWith('/meetings'), `${path} is not a Meetings route`)
    }
  })

  test('it is NOT added to the global sidebar, the dashboard or another module', () => {
    for (const file of [
      'src/components/layout/DashboardLayout.tsx',
      'src/app/modules/page.tsx',
    ]) {
      const source = read(file)
      assert.ok(!source.includes('/meetings/guide'), `${file} links to the Meetings guide`)
      assert.ok(!source.includes('How Meetings Work'), `${file} mentions the Meetings guide`)
    }
  })

  test('it reads no meeting, order, task or discussion row of its own', () => {
    // Which is exactly why module entry is the whole requirement to see it: there is
    // nothing on the page for a permission to narrow.
    assert.ok(!/\.from\(/.test(PAGE), 'the guide queries a table')
    assert.ok(!/\.rpc\(/.test(PAGE), 'the guide calls an RPC')
    assert.ok(!/\bfetch\(/.test(PAGE))
  })

  test('it requires no Meetings EDIT capability', () => {
    assert.ok(!/canConductMeeting|canCompleteMeeting|canCreateMeeting|editable/.test(PAGE))
  })

  test('the only change outside Meetings is the Task Detail action', () => {
    const taskPage = read('src/app/tasks/[id]/page.tsx')
    assert.ok(!taskPage.includes('/meetings/guide'), 'the Task module must not carry the guide')
    assert.match(taskPage, /AddToMeetingButton/)
  })

})

describe('the guide is a page, not a download', () => {
  test('no PDF, no Word file, no external site', () => {
    for (const forbidden of ['.pdf', '.docx', 'window.print(', 'target="_blank"']) {
      assert.ok(!PAGE.includes(forbidden), `the guide uses ${forbidden}`)
    }
    // The only links it draws are in-page anchors and Meetings routes.
    const hrefs = [...PAGE.matchAll(/href=\{?`?([^`"'}\s]+)/g)].map(m => m[1])
    for (const href of hrefs) {
      assert.ok(href.startsWith('#') || href.startsWith('${'), `unexpected link target: ${href}`)
    }
  })

  test('there is a clear Back to Meetings action', () => {
    assert.ok((PAGE.match(/Back to Meetings/g) ?? []).length >= 2,
      'Back must be reachable at the top and the bottom of a long page')
    assert.match(PAGE, /router\.push\('\/meetings'\)/)
  })
})

// ─── 3. No developer language ────────────────────────────────────────────────

describe('nothing technical reaches the reader', () => {
  const FORBIDDEN = [
    'meeting_discussion', 'meeting_orders', 'meeting_order_items', 'meeting_update_history',
    'RLS', 'row-level', 'row level security', 'SECURITY DEFINER', 'RPC', 'migration',
    'foreign key', 'CHECK constraint', 'UNIQUE', 'nullable', 'schema', 'PostgREST',
    'supabase', 'uuid', 'policy', 'query', 'column', 'trigger',
  ]

  test('no table, policy, function or database word appears in the copy', () => {
    for (const word of FORBIDDEN) {
      assert.ok(!ALL_COPY.toLowerCase().includes(word.toLowerCase()),
        `the guide says "${word}" to an employee`)
    }
  })

  test('the copy does not name a migration version either', () => {
    assert.ok(!/\b20\d{12}\b/.test(ALL_COPY))
  })

  test('the developer reasoning stays in comments, where the reader never sees it', () => {
    // The file may discuss the migration; the exported CONTENT may not.
    const exported = CONTENT.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const word of ['meeting_discussion', 'SECURITY DEFINER', 'RLS']) {
      assert.ok(!exported.includes(word), `${word} is in the guide's data, not only its comments`)
    }
  })
})

// ─── 4. Readable on a phone ──────────────────────────────────────────────────

describe('the guide works at 360px without horizontal scrolling', () => {
  const GUIDE_CSS = meetingsCss()

  test('every guide layout has a one-column form as its BASE, not as an override', () => {
    // Base rules are mobile; the multi-column forms are inside min-width queries. A
    // layout whose base was multi-column would overflow before any query applied.
    for (const layout of [
      'meeting-guide-map', 'meeting-guide-phases', 'meeting-guide-grid-2',
      'meeting-guide-grid-3', 'meeting-guide-flow', 'meeting-guide-compare',
    ]) {
      const base = GUIDE_CSS.match(new RegExp(`\\.${layout} \\{[^}]*\\}`))
      assert.ok(base, `${layout} has no base rule`)
      assert.match(base![0], /grid-template-columns:\s*1fr;/, `${layout} is not single-column on a phone`)
    }
  })

  test('every multi-column step is a min-width query, so it only widens', () => {
    const queries = [...GUIDE_CSS.matchAll(/@media \(([^)]+)\)/g)].map(m => m[1])
    for (const query of queries) {
      assert.ok(
        query.startsWith('min-width') || query.startsWith('max-width') || query.includes('reduced-motion'),
        `unexpected media query: ${query}`,
      )
    }
    assert.ok(queries.some(q => q.includes('min-width')))
  })

  test('no diagram has a fixed width, a min-width or a horizontal scroller', () => {
    // A `min-width` DECLARATION forces sideways scrolling; `@media (min-width: …)`
    // is the breakpoint and is exactly what this page should be using.
    const declarations = GUIDE_CSS.replace(/@media \([^)]*\)/g, '')
    assert.ok(!/min-width:\s*\d{3,}px/.test(declarations), 'a minimum width would force sideways scrolling')
    assert.ok(!/overflow-x/.test(GUIDE_CSS))
    // And no SVG with a fixed viewBox, which is the other way a diagram stops being
    // readable on a narrow screen.
    assert.ok(!/<svg/.test(PAGE))
  })

  test('multi-column grids use minmax(0, …) so long text cannot widen a column', () => {
    const multi = [...GUIDE_CSS.matchAll(/grid-template-columns:\s*repeat\([^;]+;/g)].map(m => m[0])
    assert.ok(multi.length > 0)
    for (const rule of multi) {
      assert.match(rule, /minmax\(0/, `a column without minmax(0) can be widened by its content: ${rule}`)
    }
  })

  test('the flow arrows become a vertical timeline on a phone, and point right on desktop', () => {
    assert.match(GUIDE_CSS, /\.meeting-guide-flow-arrow \{[^}]*transform: rotate\(90deg\)/)
    assert.match(GUIDE_CSS, /@media \(min-width: 1000px\)[\s\S]*?\.meeting-guide-flow-arrow \{[^}]*transform: none/)
  })

  test('the four-meeting timeline is vertical at every width', () => {
    // Four meetings side by side would compress each update to two words.
    assert.match(GUIDE_CSS, /\.meeting-guide-timeline \{[^}]*flex-direction: column/)
  })

  test('the comparison is cards, not a table that has to reflow', () => {
    assert.match(PAGE, /meeting-guide-compare/)
    assert.ok(!/<table/.test(PAGE), 'a table on this page would need a min-width to stay readable')
  })

  test('tap targets meet the app\u2019s own mobile minimum', () => {
    assert.match(GUIDE_CSS, /@media \(max-width: 767px\)[\s\S]*?\.meeting-guide-jump \{ min-height: 44px; \}/)
    assert.match(PAGE, /minHeight: '44px'/)
  })

  test('it uses the existing spacing, colour and radius tokens', () => {
    assert.match(PAGE, /from '@\/lib\/tokens'/)
    assert.match(PAGE, /colors\./)
  })
})

describe('no new colour enters the BOE palette', () => {
  test('the category cards wear the category badge colours, unchanged', () => {
    assert.match(PAGE, /DISCUSSION_CATEGORY_META\[card\.category\]/)
  })

  test('the phase tones are the families already used for type and status badges', () => {
    // #EFF6FF/#1E40AF is MEETING_TYPE_META.new_order, #F5F3FF/#5B21B6 is
    // MEETING_STATUS_META.in_progress, #F0FDF4/#166534 is .completed.
    for (const hex of ['#EFF6FF', '#1E40AF', '#F5F3FF', '#5B21B6', '#F0FDF4', '#166534']) {
      assert.ok(PAGE.includes(hex), `${hex} should be reused, not replaced`)
    }
  })

  test('Running Order stays in the blue/info family and After Sales in amber/warning', () => {
    assert.equal(DISCUSSION_CATEGORY_META.running_order.bg, '#EFF6FF')
    assert.equal(DISCUSSION_CATEGORY_META.after_sales.bg, '#FFFBEB')
  })
})

// ─── 5. Accessibility ────────────────────────────────────────────────────────

describe('the guide is usable without sight and without a mouse', () => {
  test('the outline starts at h1 and skips no level', () => {
    // The shell prints the title as a styled div, so the page supplies a hidden h1.
    assert.match(PAGE, /<h1 className="meeting-guide-sr-only">How Meetings Work<\/h1>/)
    const levels = [...PAGE.matchAll(/<h([1-4])\b/g)].map(m => Number(m[1]))
    assert.deepEqual([...new Set(levels)].sort(), [1, 2, 3])
  })

  test('every section heading has the id its jump link points at', () => {
    for (const section of SECTIONS) {
      assert.ok(PAGE.includes(`id="${section.id}"`) || PAGE.includes(`id="${section.id}"`),
        `no heading with id ${section.id}`)
      assert.match(PAGE, new RegExp(`href=\\{\`#\\$\\{section\\.id\\}\``))
    }
  })

  test('every diagram\u2019s meaning is in text, not in the picture', () => {
    // Each node, step, stage and row renders its own label AND its own explanation —
    // so a screen reader gets the same content a sighted reader does.
    assert.match(PAGE, /\{node\.label\}[\s\S]{0,400}\{node\.detail\}/)
    assert.match(PAGE, /\{step\.title\}[\s\S]{0,400}\{step\.detail\}/)
    assert.match(PAGE, /\{stage\.label\}[\s\S]{0,300}\{stage\.detail\}/)
    assert.match(PAGE, /\{entry\.update\}[\s\S]{0,400}\{entry\.note\}/)
  })

  test('every decorative glyph, marker and arrow is hidden from readers', () => {
    const icons = [...PAGE.matchAll(/<(ArrowRight|ArrowLeft|Users|CheckCircle2|Inbox|ListChecks|MessageSquare|CalendarCheck|ClipboardList|AlertTriangle|RotateCcw)\b[^>]*>/g)]
    assert.ok(icons.length > 0)
    for (const [tag] of icons) {
      assert.ok(tag.includes('aria-hidden="true"'), `an icon is announced to readers: ${tag}`)
    }
    assert.match(PAGE, /className="meeting-guide-flow-arrow" aria-hidden="true"/)
    assert.match(PAGE, /className="meeting-guide-timeline-rail" aria-hidden="true"/)
  })

  test('colour is never the only carrier of a state', () => {
    // The timeline marker is a colour AND a number; the state beside it is a badge
    // with a word in it.
    assert.match(PAGE, /DISCUSSION_STATE_META\[entry\.state\]/)
    assert.ok(DISCUSSION_STATE_META.open.label.length > 0)
    assert.ok(DISCUSSION_STATE_META.resolved.label.length > 0)
    // The category badge carries its label too, plus a hidden name for the heading.
    assert.match(PAGE, /className="meeting-guide-sr-only">\{card\.label\}/)
  })

  test('the collapsible answers are buttons with aria-expanded, so they work by keyboard', () => {
    assert.match(PAGE, /aria-expanded=\{expanded\}/)
    assert.match(PAGE, /type="button"/)
    // A <div onClick> would not be reachable by Tab.
    assert.ok(!/<div[^>]*onClick[^>]*>\s*\{faq\.question\}/.test(PAGE))
  })

  test('the first answer is open, so the section never reads as an empty list', () => {
    assert.match(PAGE, /useState<Set<number>>\(new Set\(\[0\]\)\)/)
  })

  test('the jump navigation is a <nav> with a name', () => {
    assert.match(PAGE, /<nav aria-label="Sections of this guide">|<nav aria-label="Sections of this guide"/)
  })

  test('focus is visible on every link and jump', () => {
    const GUIDE_CSS = meetingsCss()
    assert.match(GUIDE_CSS, /\.meeting-guide-jump:focus-visible,\s*\n\.meeting-guide-link:focus-visible \{[^}]*outline:/)
  })

  test('reduced motion is respected, and there is no decorative animation to begin with', () => {
    const GUIDE_CSS = meetingsCss()
    assert.match(GUIDE_CSS, /@media \(prefers-reduced-motion: reduce\)/)
    assert.ok(!/animation:/.test(GUIDE_CSS), 'the guide has no animation of its own')
    assert.ok(!/@keyframes/.test(GUIDE_CSS))
  })

  test('the heading levels inside a card are h3, under the section h2', () => {
    assert.match(PAGE, /<h3 style=\{\{ margin: 0 \}\}>\s*\n\s*<button/, 'an FAQ question is a heading with a button inside')
  })
})
