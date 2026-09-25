/**
 * Account Settings → Back must never leave BOE.
 *
 * THE DEFECT. /account followed `returnTo` whenever it started with "/" but not
 * "//". Browsers read "\" as "/" in http(s) URLs and strip tabs and newlines, so
 * "/\evil.com", "/\/evil.com" and "/<tab>/evil.com" all passed that check and
 * `router.push` sent the user to another site.
 *
 * NOW. Account uses the validator Task Detail already relied on (PR #150), moved
 * to src/lib/safeReturnPath.ts so both share one copy. Account now sits in the
 * shared sidebar shell, so anything the validator refuses simply shows no Back
 * link; a valid path shows one.
 *
 * Run:
 *   npx tsx --test src/lib/safeReturnPath.test.ts src/lib/tasks/taskReturnPath.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_RETURN_PATH_LENGTH, safeReturnPath } from './safeReturnPath'
import * as taskReturnPath from './tasks/taskReturnPath'

const BOE = 'https://boe-task-management.vercel.app'

/**
 * Exactly what the Account page computes for its Back link: the validated
 * path, or null — and null renders NO Back link (the sidebar is the way out).
 */
const accountBackTarget = (raw: string | null) => safeReturnPath(raw)

/** One character by code, so no invisible character has to sit in this file. */
const ch = (code: number) => String.fromCharCode(code)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── Root cause ──────────────────────────────────────────────────────────────

describe('the old check let off-site values through', () => {
  const oldCheck = (raw: string) => raw.startsWith('/') && !raw.startsWith('//')

  for (const value of ['/\\evil.com', '/\\/evil.com', '/' + ch(0x09) + '/evil.com']) {
    test(JSON.stringify(value), () => {
      assert.equal(oldCheck(value), true, 'the old predicate accepted it')
      assert.equal(new URL(value, BOE).origin, 'https://evil.com', 'a browser resolves it off-site')
      assert.equal(accountBackTarget(value), null)
    })
  }
})

// ── 1–2. What is accepted ───────────────────────────────────────────────────

describe('internal BOE paths are followed unchanged (1–2)', () => {
  for (const path of [
    '/modules',
    '/dashboard',
    '/tasks/my',
    '/tasks/my?tab=working&page=2',
    '/orders',
    '/admin/control-center',
    '/attendance?month=2026-09',
    '/tasks/assigned-by-me?q=quote+request#top',
  ]) {
    test(path, () => {
      assert.equal(safeReturnPath(path), path)
      assert.equal(accountBackTarget(path), path)
      assert.equal(new URL(path, BOE).origin, BOE)
    })
  }

  test('an encoded ?returnTo= comes back exactly', () => {
    const source = '/tasks/my?tab=working&page=2'
    const params = new URL(`/account?returnTo=${encodeURIComponent(source)}`, BOE).searchParams
    assert.equal(accountBackTarget(params.get('returnTo')), source)
  })
})

// ── 3–10. What gets no Back link ────────────────────────────────────────────

describe('anything that could leave BOE gets no Back link (3–10)', () => {
  const refused: [string, string | null][] = [
    ['https://', 'https://evil.com'],
    ['http://', 'http://evil.com'],
    ['upper-case scheme', 'HTTPS://evil.com'],
    ['protocol-relative //', '//evil.com'],
    ['triple slash', '///evil.com'],
    ['/\\evil.com', '/\\evil.com'],
    ['/\\/evil.com', '/\\/evil.com'],
    ['/\\\\evil.com', '/\\\\evil.com'],
    ['leading backslash', '\\evil.com'],
    ['leading double backslash', '\\\\evil.com'],
    ['backslash inside a path', '/modules\\evil.com'],
    ['backslash in the query', '/modules?next=\\evil.com'],
    ['tab smuggling', '/' + ch(0x09) + '/evil.com'],
    ['newline smuggling', '/' + ch(0x0a) + '/evil.com'],
    ['carriage-return smuggling', '/' + ch(0x0d) + '/evil.com'],
    ['leading space', ' /modules'],
    ['NUL', '/modules' + ch(0x00)],
    ['unit separator', '/' + ch(0x1f) + '/evil.com'],
    ['DEL', '/modules' + ch(0x7f)],
    ['C1 control', '/modules' + ch(0x85)],
    ['non-breaking space', '/' + ch(0xa0) + '/evil.com'],
    ['line separator', '/' + ch(0x2028) + '/evil.com'],
    ['byte-order mark', '/' + ch(0xfeff) + '/evil.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JavaScript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['missing', null],
    ['empty', ''],
    ['relative without a slash', 'modules'],
    ['bare host', 'evil.com'],
    ['query only', '?tab=working'],
    ['fragment only', '#top'],
  ]
  for (const [label, value] of refused) {
    test(label, () => {
      assert.equal(safeReturnPath(value), null)
      assert.equal(accountBackTarget(value), null)
    })
  }

  test('excessively long values (the limit itself is still followed)', () => {
    const atLimit = '/' + 'a'.repeat(MAX_RETURN_PATH_LENGTH - 1)
    assert.equal(accountBackTarget(atLimit), atLimit)
    assert.equal(accountBackTarget(atLimit + 'a'), null)
  })

  test('the backslash cases really contain backslashes', () => {
    assert.equal('/\\evil.com'.charCodeAt(1), 0x5c)
    assert.equal('/\\evil.com'.length, 10)
    assert.equal('/\\/evil.com'.length, 11)
  })

  test('this file carries no invisible characters of its own', () => {
    const invisible = [...read('src/lib/safeReturnPath.test.ts')].filter(c => {
      const code = c.charCodeAt(0)
      return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0xa0)
        || (code >= 0x2000 && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0xfeff
    })
    assert.deepEqual(invisible, [])
  })
})

// ── 11. One validator ───────────────────────────────────────────────────────

describe('Task Detail and Account share one validator (11)', () => {
  test('taskReturnPath re-exports the very same function', () => {
    assert.equal(taskReturnPath.safeReturnPath, safeReturnPath)
    assert.equal(taskReturnPath.MAX_RETURN_PATH_LENGTH, MAX_RETURN_PATH_LENGTH)
  })

  test('taskReturnPath.ts holds no second copy', () => {
    const code = codeOf(read('src/lib/tasks/taskReturnPath.ts'))
    assert.ok(code.includes("export { MAX_RETURN_PATH_LENGTH, safeReturnPath } from '@/lib/safeReturnPath'"))
    assert.equal(code.includes('function safeReturnPath'), false)
    assert.equal(code.includes('new URL('), false)
  })
})

// ── Wiring ──────────────────────────────────────────────────────────────────

describe('Account Settings Back button', () => {
  const page = codeOf(read('src/app/account/page.tsx'))

  // The page sits in the shared BoeOsLayout shell. The Back link rides in the
  // shell's title-row slot and exists only when safeReturnPath accepted the
  // ?returnTo= value — there is no fallback destination, and no second header.
  test('reads returnTo only through safeReturnPath, with no fallback', () => {
    assert.ok(page.includes("import { safeReturnPath } from '@/lib/safeReturnPath'"))
    assert.ok(page.includes("const returnTo     = safeReturnPath(searchParams.get('returnTo'))\n"))
    // Exactly one read of the parameter, so nothing bypasses the validator.
    assert.equal(page.split("searchParams.get('returnTo')").length - 1, 1)
  })

  test('renders the Back link only when there is a valid destination', () => {
    assert.ok(page.includes('headerActions={returnTo ? ('))
    assert.ok(page.includes('<Link href={returnTo} className="boe-btn boe-btn-ghost">'))
    assert.ok(page.includes(') : null}'))
    // Navigation is the Link itself — no imperative push of the parameter.
    assert.equal(page.includes('router.push(returnTo)'), false)
  })

  test('keeps the shared shell and does not restore the old header', () => {
    assert.ok(page.includes('<BoeOsLayout'))
    assert.equal(page.includes('BoeBrandIcon'), false)
    assert.equal(page.includes("position: 'sticky'"), false)
  })

  test('the old prefix check is gone', () => {
    assert.equal(page.includes('rawReturn'), false)
    assert.equal(page.includes("startsWith('//')"), false)
  })
})
