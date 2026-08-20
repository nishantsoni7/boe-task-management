/**
 * Phase C — what the phase must NOT have changed.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * finalApproval.test.ts proves the new rules behave. finalApprovalSchema.test.ts
 * proves the migration keeps its promises. Neither would notice the failure this
 * file is for: a phase that quietly reshapes the product table, the import
 * preview or an applied migration while adding a genuinely correct approval
 * flow. Those regressions are invisible in a diff summary and catastrophic in
 * production, so they are asserted against the STARTING COMMIT itself rather
 * than against a description of it.
 *
 * The starting commit is pinned. If Phase C is ever rebased onto a later main,
 * this constant moves with it deliberately, in one place, as a visible decision.
 *
 * Reads repository files and `git show`. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/finalApprovalScope.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The production SHA this phase started from. */
const BASE = '700a30c7a978ee0f6bcc92c5616bd9d6b39978f8'

const lf = (s: string) => s.replace(/\r\n/g, '\n')

/**
 * A file as it stood at the starting commit, or null when git cannot answer.
 *
 * NULL IS TOLERATED, and deliberately: a shallow clone or an exported archive
 * has no object for that commit, and a test that fails because of how the
 * repository was fetched teaches people to ignore it. Where git IS available —
 * every developer machine and CI — the comparison is exact.
 */
function atBase(path: string): string | null {
  try {
    return lf(execFileSync('git', ['show', `${BASE}:${path}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return null
  }
}

const now = (path: string) => lf(readFileSync(path, 'utf8'))

/** The text between two markers, exclusive of the second. */
function region(source: string, start: string, end: string, label: string): string {
  const i = source.indexOf(start)
  assert.notEqual(i, -1, `${label}: opening marker not found`)
  const j = source.indexOf(end, i)
  assert.notEqual(j, -1, `${label}: closing marker not found`)
  return source.slice(i, j)
}

const DETAIL_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const PREVIEW = 'src/components/orders/piPreview.tsx'
const IMPORT_PAGE = 'src/app/orders/import/page.tsx'
const PREVIEW_VIEW = 'src/lib/pi/previewView.ts'
const PARSER = 'src/lib/pi/masterSheetParser.ts'

// ── The product table ─────────────────────────────────────────────────────────

describe('the PI product table is byte-for-byte what it was', () => {
  test('the whole Products card on the detail page is unchanged', () => {
    const base = atBase(DETAIL_PAGE)
    if (base === null) return

    const MARKERS = ['{/* Products */}', '{/* ── 6. The lower information grid ──'] as const
    assert.equal(
      region(now(DETAIL_PAGE), ...MARKERS, 'current'),
      region(base, ...MARKERS, 'base'),
      'the mobile cards, the desktop table, every column and every style are unchanged',
    )
  })

  test('the shared table head and thumbnails are untouched', () => {
    const base = atBase(PREVIEW)
    if (base === null) return
    assert.equal(now(PREVIEW), base,
      'piPreview.tsx is shared with the import preview; a change here changes two screens')
  })

  test('the columns themselves are still the ones the workbook has', () => {
    // A belt-and-braces reading of the declaration, so a future refactor that
    // rewrote the head component would still have to keep the columns and their
    // order. The labels are read from the definition rather than the markup:
    // that is where they live, and where a change would be made.
    const columns = region(
      now(PREVIEW), 'export const PI_PRODUCT_COLUMNS', 'export function PiProductTableHead', 'columns')
    const labels = [...columns.matchAll(/label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(labels, [
      '#', 'Image', 'Product', 'Qty', 'Dimensions', 'Material',
      'Customization', 'Cost / piece', 'Line total',
    ])
    assert.ok(columns.includes("accent: 'customization'"),
      'and Customization keeps the accent that separates it from Material')
  })
})

// ── The import preview ────────────────────────────────────────────────────────

// WHY THE WHOLE-FILE COMPARISON NARROWED.
//
// This guard read the import screen byte-for-byte against the pinned commit,
// because Phase C changes what happens AFTER a PI is submitted and nothing
// about uploading one. That is still the property worth holding. What made the
// whole-file proxy wrong is a later, deliberate layout decision: the
// ready-to-submit card — the verdict on the PI and the Save Draft button — now
// sits directly under the order information and above the product table,
// instead of at the bottom of the preview.
//
// So the guard asserts the more specific thing the byte comparison stood in
// for: the card's markup is IDENTICAL, everything around it is IDENTICAL, and
// the only difference is where the card was inserted. A change to the drop
// zone, the parse wiring, the save flow, or the card's own contents still fails
// here, exactly as it did before.

const READY_CARD_START = '{/* Ready state, and the one action this phase performs.'

/** The ready-to-submit card, and the screen with that card lifted out of it. */
function readyCard(source: string, label: string): { card: string; rest: string } {
  const start = source.indexOf(READY_CARD_START)
  assert.notEqual(start, -1, `${label}: the ready-to-submit card must still be there`)
  // Its next sibling, whichever it now is: the standing-promise note when the
  // card sits last, the products card when it sits above the table.
  const ends = ['{/* The standing promise of this screen', '{/* Products */}']
    .map(marker => source.indexOf(marker, start))
    .filter(index => index !== -1)
  assert.ok(ends.length > 0, `${label}: the card must be followed by a sibling this guard knows`)
  const end = Math.min(...ends)
  return { card: source.slice(start, end), rest: source.slice(0, start) + source.slice(end) }
}

describe('the import preview and the parser are untouched', () => {
  test('the import screen is what it was, apart from where the ready card sits', () => {
    const base = atBase(IMPORT_PAGE)
    if (base === null) return
    const was = readyCard(base, 'base')
    const is = readyCard(now(IMPORT_PAGE), 'current')
    assert.equal(is.card, was.card,
      'the verdict, the Save Draft button, the saving and failure states are unchanged')
    assert.equal(is.rest, was.rest,
      'and nothing else on the screen changed: Phase C still touches nothing about uploading a PI')
  })

  test('the ready card and its Save Draft button are above the product table', () => {
    const source = now(IMPORT_PAGE)
    assert.ok(source.indexOf(READY_CARD_START) < source.indexOf('{/* Products */}'),
      'the verdict on the PI comes before the lines it is a verdict on')
    assert.ok(source.indexOf('SAVE_BUTTON_LABEL}') < source.indexOf('<PiProductTableHead'),
      'and so does the one control this screen has')
    assert.equal((source.match(/READY_TITLE/g) ?? []).length, 2,
      'the import and the one rendering of it — the card is drawn once, never twice')
  })

  test('the shared preview view layer is byte-for-byte what it was', () => {
    const base = atBase(PREVIEW_VIEW)
    if (base === null) return
    assert.equal(now(PREVIEW_VIEW), base)
  })

  test('the workbook parser is byte-for-byte what it was', () => {
    const base = atBase(PARSER)
    if (base === null) return
    assert.equal(now(PARSER), base,
      'no cell, no header rule and no diagnostic changed')
  })
})

// ── The applied migrations ────────────────────────────────────────────────────

// A later migration is allowed to exist — the company ships other things. What
// this guard is really protecting is that it does not REACH INTO the PI
// submission tables. Until 20260918000000 the filename was a good enough proxy
// for that, because every later file so far belonged to this feature; the first
// unrelated phase to land made the proxy wrong rather than the property wrong.
//
// So the property is now tested directly: a later file passes if it belongs to
// this feature by name, OR if it does not restructure order_submissions or its
// children. Naming one of those tables as a FOREIGN KEY TARGET or reading it is
// explicitly fine — that is what a neighbouring module is supposed to do, and it
// changes nothing about approval, deletion or the schema this suite guards.
// The ONE structural change an outside phase is allowed to make to these tables,
// and the reason it is allowed: order_submission_activity.action is a CLOSED set,
// and 20260915000000 §10 states that a phase producing a new kind of event
// extends it "in its own migration — a visible change rather than a silent new
// event type". That IS the sanctioned extension point, so a migration that only
// drops and re-adds the action CHECK is doing what the design asks of it.
//
// Nothing else is forgiven: the statements below are removed before the
// structural test runs, so a file that also alters a column, adds a policy, or
// writes a row still fails on that.
const PI_ACTIVITY_ACTION_CHECK_EXTENSION =
  /(?:execute\s+format\(\s*'alter\s+table\s+(?:public\.)?order_submission_activity\s+drop\s+constraint[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+(?:drop|add)\s+constraint\s+[^;]*order_submission_activity_action_check[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+add\s+constraint\s+order_submission_activity_action_check[^;]*;)/gi

function withoutSanctionedActivityExtension(sql: string): string {
  return sql.replace(PI_ACTIVITY_ACTION_CHECK_EXTENSION, '')
}

const PI_STRUCTURAL_CHANGE =
  /(alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|(?:alter|drop|create)\s+policy\s+[^;]*\bon\s+(?:public\.)?order_submission\w*)/i

function reachesIntoPiSubmissions(file: string): boolean {
  if (/order_submission/i.test(file)) return false          // this feature's own work
  const sql = withoutSanctionedActivityExtension(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8'))
  return PI_STRUCTURAL_CHANGE.test(sql)
}

describe('no applied migration was edited, renamed or reapplied', () => {
  const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
  const CUTOFF = '20260914000000_order_submission_permanent_deletion.sql'

  test('every migration up to and including the cutoff is unchanged', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    let compared = 0

    for (const file of files.filter(f => f <= CUTOFF)) {
      const path = `supabase/migrations/${file}`
      const base = atBase(path)
      if (base === null) continue
      assert.equal(now(path), base, `${file} is applied and must never be edited`)
      compared += 1
    }

    // If git answered at all, it must have answered for the cutoff itself —
    // otherwise this suite would pass by comparing nothing.
    if (atBase(`supabase/migrations/${CUTOFF}`) !== null) {
      assert.ok(compared > 100, `expected to compare the whole applied history, compared ${compared}`)
    }
  })

  test('none of them was deleted or renamed', () => {
    const files = new Set(readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')))
    let listed: string[] = []
    try {
      listed = execFileSync('git', ['ls-tree', '--name-only', `${BASE}:supabase/migrations`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n').filter(name => name.endsWith('.sql'))
    } catch {
      return
    }
    for (const file of listed) {
      assert.ok(files.has(file), `${file} existed at the starting commit and is now missing`)
    }
  })

  test('Phase C itself added exactly one migration, after the cutoff', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const PHASE_C = '20260915000000_order_submission_final_approval.sql'
    assert.deepEqual(files.filter(f => f > CUTOFF && f <= PHASE_C), [PHASE_C])
    // Later files are allowed and must belong to this feature. 20260916000000 is
    // the Test Data Cleanup fix for the mutual foreign key Phase C introduced.
    for (const file of files.filter(f => f > PHASE_C)) {
      assert.equal(reachesIntoPiSubmissions(file), false,
        `${file} lands after Phase C and restructures the PI submission tables`)
    }
  })
})

// ── No client-side numbering, anywhere in the application ─────────────────────

describe('nothing in the browser generates or guesses an Order number', () => {
  /** Every TypeScript source under src, excluding test files. */
  function sources(dir = 'src', out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) sources(path, out)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }

  const files = sources()

  test('there is no max(display_number) + 1, in any form', () => {
    for (const file of files) {
      const source = now(file)
      assert.ok(!/max\s*\(\s*['"]?display_number/i.test(source), `${file}`)
      assert.ok(!/display_number\s*\+\s*1/.test(source), `${file}`)
      assert.ok(!/order\('display_number'[^)]*\)[\s\S]{0,120}\.limit\(1\)/.test(source),
        `${file} reads the highest existing number, which is the same defect by another route`)
    }
  })

  test('no client code calls the allocator, or reads the cycle table', () => {
    // THE ADMIN CYCLE SCREEN IS LEGITIMATE and is deliberately not caught here:
    // get_confirmed_order_number_cycle() and set_next_confirmed_order_number()
    // are the sanctioned, admin-only doors, and Control Center calls the first
    // of them. What must never appear is the ALLOCATOR — which is revoked from
    // every role and reachable only through the INSERT trigger — or a direct
    // read of the cycle table, which has RLS with no policies at all.
    for (const file of files) {
      const source = now(file)
      for (const forbidden of [
        "rpc('allocate_confirmed_order_number'", "rpc('next_order_display_number'",
        "rpc('assign_order_display_number'", ".from('order_number_cycle')",
      ]) {
        assert.ok(!source.includes(forbidden), `${file} reaches for ${forbidden}`)
      }
    }
  })

  test('no browser writes public.orders', () => {
    for (const file of files) {
      const source = now(file)
      if (!source.includes(".from('orders')")) continue
      const usage = source.slice(source.indexOf(".from('orders')"))
      assert.ok(!/^\s*\.(insert|upsert)\(/m.test(usage.slice(0, 400)),
        `${file} inserts into public.orders; only a definer RPC may create one`)
    }
  })

  test('the PI screens send no order number to the database, ever', () => {
    for (const file of files.filter(f => f.includes('orders/drafts') || f.includes('orders/import'))) {
      const source = now(file)
      assert.ok(!/p_display_number|p_order_number|display_number:/.test(source), `${file}`)
    }
  })
})

// ── No payment writes ─────────────────────────────────────────────────────────

describe('this phase records no payment of any kind', () => {
  test('the PI screens touch no Finance or payment table', () => {
    for (const file of [DETAIL_PAGE, 'src/app/orders/drafts/page.tsx']) {
      const tables = [...now(file).matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
      for (const table of tables) {
        assert.ok(!/payment|finance/i.test(table), `${file} reads ${table}`)
      }
    }
  })

  test('the only new RPCs are the two this phase adds', () => {
    const source = now(DETAIL_PAGE)
    const rpcs = [...source.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    for (const name of rpcs) {
      assert.ok(!/payment|receipt|reconcil/i.test(name), `${name} moves money`)
    }
    assert.ok(rpcs.includes('verify_pi_finance_check'))
    assert.ok(rpcs.includes('approve_order_submission'))
  })

  test('final approval happens through the new RPC and nothing else', () => {
    // One door, named once, on one screen. If a second screen ever grows an
    // approval it must be a deliberate, visible change here first.
    const callers: string[] = []
    for (const file of readdirSync('src/app', { recursive: true, withFileTypes: true }) as unknown as {
      name: string; parentPath?: string; path?: string; isFile(): boolean
    }[]) {
      if (!file.isFile() || !/\.tsx?$/.test(file.name) || /\.test\./.test(file.name)) continue
      const path = join(file.parentPath ?? file.path ?? 'src/app', file.name)
      if (now(path).includes("rpc('approve_order_submission'")) callers.push(path)
    }
    assert.deepEqual(callers, [DETAIL_PAGE])
  })
})
