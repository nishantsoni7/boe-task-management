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

describe('the import preview and the parser are untouched', () => {
  test('the import screen is byte-for-byte what it was', () => {
    const base = atBase(IMPORT_PAGE)
    if (base === null) return
    assert.equal(now(IMPORT_PAGE), base,
      'Phase C changes what happens AFTER a PI is submitted, and nothing about uploading one')
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

  test('Phase C added exactly one migration, after the cutoff', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.deepEqual(files.filter(f => f > CUTOFF),
      ['20260915000000_order_submission_final_approval.sql'])
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
