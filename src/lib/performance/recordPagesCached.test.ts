// EVERY RECORD PAGE IS PREPARED ONCE AND CACHED; THE STATIC FILES ARE KEPT FOR A DAY (2026-11-14).
//
// A route with a dynamic segment ([id], [token] ...) is rendered by a server function in Tokyo on every
// open unless its segment says it may be prepared and kept: a server layout that returns an empty
// generateStaticParams. Measured from India: about 0.46 s per open through the function against about
// 0.27 s from the edge cache, and the function can also start cold. src/lib/orders/recordPagesCached.test.ts
// pins the two order pages; this pins ALL of them, so a record page added later cannot quietly go back to
// being rendered on every click.
//
// That is only safe while a page's SERVER output is the same for every reader: each of these pages is a
// client component, or a thin wrapper around one, that reads its data in the browser under the reader's
// own access. The tests pin that nothing under a cached route reads cookies, headers or the session on the
// server, which is also what would make Next refuse to cache it.
//
// The second half pins the Cache-Control rules for /brand and the web manifest (next.config.ts).
//
// Run with: npx tsx --test "src/lib/performance/recordPagesCached.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(__dirname, '..', '..', '..')
const APP = join(ROOT, 'src', 'app')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const posix = (p: string) => relative(APP, p).split(sep).join('/')

// A dynamic segment with a reason it is left to render per request. Keep this short.
const LEFT_DYNAMIC: Record<string, string> = {
  'customer-reviews/[id]': 'retired page: it redirects on the server, there is nothing to prepare',
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

/** Every dynamic-segment folder outside /api that has a page somewhere at or below it. */
function dynamicSegmentDirs(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (!statSync(p).isDirectory() || entry === 'api') continue
    if (/^\[[^\].]+\]$/.test(entry) && sourcesUnder(p).some(f => /[\\/]page\.tsx$/.test(f))) out.push(p)
    dynamicSegmentDirs(p, out)
  }
  return out
}

const DIRS = dynamicSegmentDirs()
const COVERED = DIRS.filter(d => !(posix(d) in LEFT_DYNAMIC))

const READS_REQUEST = /from ['"]next\/headers['"]|\bcookies\(\)|\bheaders\(\)|unstable_noStore|connection\(\)|force-dynamic/

describe('every record page is prepared once and cached', () => {
  test('the search finds the record pages (so the checks below are not vacuous)', () => {
    assert.ok(DIRS.length >= 28, `found only ${DIRS.length} dynamic segments`)
    for (const known of ['orders/[id]', 'tasks/[id]', 'meetings/[id]', 'quotations/[id]', 'vendors/[id]']) {
      assert.ok(DIRS.some(d => posix(d) === known), known)
    }
  })

  test('every dynamic segment that is not on the short exception list has the layout', () => {
    const missing = COVERED.filter(d => !existsSync(join(d, 'layout.tsx'))).map(posix)
    assert.deepEqual(missing, [], 'add src/app/<route>/layout.tsx like src/app/tasks/[id]/layout.tsx')
  })

  test('each layout is a server component with an empty generateStaticParams that passes its children through', () => {
    for (const d of COVERED) {
      const layout = read(join(d, 'layout.tsx'))
      assert.match(layout, /export function generateStaticParams\(\) \{\s*return \[\]\s*\}/, posix(d))
      assert.match(layout, /\{ children \}: \{ children: React\.ReactNode \}\) \{\s*return children\s*\}/, posix(d))
      assert.equal(/['"]use client['"]/.test(layout), false, `${posix(d)}: a layout that exports generateStaticParams must be a server component`)
    }
  })

  test('nothing under a cached route reads cookies, headers or the session on the server', () => {
    for (const d of COVERED) {
      for (const file of sourcesUnder(d)) {
        assert.equal(READS_REQUEST.test(code(file)), false, `${posix(d)}: ${posix(file)} reads request data on the server`)
      }
    }
  })

  test('the layouts above them do not either', () => {
    const ancestors = new Set<string>()
    for (const d of COVERED) {
      let up = join(d, '..')
      while (up.startsWith(APP)) {
        const l = join(up, 'layout.tsx')
        if (existsSync(l)) ancestors.add(l)
        if (up === APP) break
        up = join(up, '..')
      }
    }
    for (const file of ancestors) assert.equal(READS_REQUEST.test(code(file)), false, `${posix(file)} reads request data on the server`)
  })

  test('the exceptions still earn their place', () => {
    for (const key of Object.keys(LEFT_DYNAMIC)) {
      assert.ok(DIRS.some(d => posix(d) === key), `${key} is on the exception list but is no longer a dynamic page`)
      assert.equal(existsSync(join(APP, key, 'layout.tsx')), false, `${key} now has the layout: take it off the exception list`)
    }
  })
})

type HeaderRule = { source: string; headers: { key: string; value: string }[] }
// A file:// address: Windows refuses a bare absolute path in import().
async function headerRules(): Promise<HeaderRule[]> {
  const config = (await import(pathToFileURL(join(ROOT, 'next.config.ts')).href)).default as { headers: () => Promise<HeaderRule[]> }
  return config.headers()
}

describe('the brand files and the manifest are cached for a day', () => {
  test('next.config.ts sends a day of max-age and a week of stale-while-revalidate for both', async () => {
    const rules = await headerRules()
    for (const source of ['/brand/:path*', '/manifest.json']) {
      const rule = rules.find(r => r.source === source)
      assert.ok(rule, `${source} has a header rule`)
      const cc = rule.headers.find(h => h.key === 'Cache-Control')?.value
      assert.equal(cc, 'public, max-age=86400, stale-while-revalidate=604800', source)
    }
  })

  test('the phone-alerts service worker is still never cached', async () => {
    const sw = (await headerRules()).find(r => r.source === '/sw.js')
    assert.match(sw?.headers.find(h => h.key === 'Cache-Control')?.value ?? '', /no-store/)
  })
})
