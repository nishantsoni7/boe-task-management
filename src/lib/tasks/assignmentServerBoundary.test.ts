// THE SERVICE-ROLE BOUNDARY, CHECKED THROUGH THE WHOLE IMPORT GRAPH.
//
// The assignment notification is written with the service-role credential,
// because it is the only client that may address a notifications row to
// somebody else. That credential must never be reachable from a browser.
//
// WHY A GRAPH AND NOT A GREP. src/lib/supabase/adminClient.test.ts already
// checks that no 'use client' file imports the admin helper DIRECTLY. That is
// the right rule and it is not the whole rule: a client component importing a
// module that imports the helper leaks it just as thoroughly, and reads
// perfectly innocent at both call sites. This resolves every import, to any
// depth, and reports the PATH — so a failure names the chain rather than
// leaving somebody to find it.
//
// WHY NOT TRUST THE BUNDLER. When this fix first landed, one module held both
// the browser helpers and the writer, and four client screens imported it. The
// production bundle was checked and contained neither the writer's SELECT
// literal nor the credential — tree-shaking had removed it. That is a build
// optimisation, not a boundary: one type-and-value import or one barrel
// re-export and privileged code rides in with nothing failing to say so. The
// modules are split now, and this test is what keeps them split.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'

const ROOT = process.cwd()
const SRC  = join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

const ALL_FILES = walk(SRC)
const rel = (f: string) => relative(ROOT, f)

const CLIENT_FILES = ALL_FILES.filter(f =>
  /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8').slice(0, 400)))

/** Every specifier the file imports or re-exports, static or dynamic. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.push(m[1])
  }
  return out
}

/** Resolve `@/…` and relative specifiers to a file on disk; skip packages. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null // node_modules — not our graph
  for (const cand of [
    base, `${base}.ts`, `${base}.tsx`,
    join(base, 'index.ts'), join(base, 'index.tsx'),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** Every file reachable from `entry` by following imports. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    const path = seen.get(file)!
    for (const spec of specifiersOf(file)) {
      const target = resolveSpecifier(file, spec)
      if (!target || seen.has(target)) continue
      seen.set(target, [...path, target])
      queue.push(target)
    }
  }
  return seen
}

/** Cached once — the graph is walked from ~50 entry points. */
const REACHABLE = new Map<string, Map<string, string[]>>()
const graphFor = (f: string) => {
  if (!REACHABLE.has(f)) REACHABLE.set(f, reachableFrom(f))
  return REACHABLE.get(f)!
}

const WRITER = join(SRC, 'lib/tasks/assignmentNotificationWriter.server.ts')
const ADMIN  = join(SRC, 'lib/supabase/admin.ts')

// ── The scan must be real ────────────────────────────────────────────────────

describe('the scan is not vacuous', () => {
  test('there are client components, and the writer exists to be found', () => {
    assert.ok(CLIENT_FILES.length > 20, `only ${CLIENT_FILES.length} client files`)
    assert.ok(existsSync(WRITER), 'the server-only writer module exists')
    assert.ok(existsSync(ADMIN), 'the admin client helper exists')
  })

  test('the graph walker actually resolves imports', () => {
    // If resolution silently returned null for everything, every test below
    // would pass by finding nothing. Prove it reaches a known transitive edge:
    // the writer imports notificationWrites, which imports notifications.
    const reach = graphFor(WRITER)
    assert.ok(reach.has(join(SRC, 'lib/notificationWrites.ts')), 'direct import resolved')
    assert.ok(reach.has(join(SRC, 'lib/notifications.ts')), 'TRANSITIVE import resolved')
    assert.ok(reach.size > 2, `graph is ${reach.size} files; resolution is probably broken`)
  })
})

// ── 1. No service-role client is reachable from a client component ───────────

describe('no privileged module is reachable from any client component', () => {
  test('the server-only writer is not reachable from a browser, at any depth', () => {
    const offenders = CLIENT_FILES
      .map(f => ({ f, path: graphFor(f).get(WRITER) }))
      .filter(x => x.path)
      .map(x => x.path!.map(rel).join('\n    -> '))
    assert.deepEqual(offenders, [], `writer reachable via:\n    ${offenders.join('\n\n    ')}`)
  })

  test('the admin client helper is not reachable from a browser, at any depth', () => {
    const offenders = CLIENT_FILES
      .map(f => ({ f, path: graphFor(f).get(ADMIN) }))
      .filter(x => x.path)
      .map(x => x.path!.map(rel).join('\n    -> '))
    assert.deepEqual(offenders, [], `admin helper reachable via:\n    ${offenders.join('\n\n    ')}`)
  })

  test('nor is @supabase/supabase-js reached for a privileged purpose', () => {
    // The browser legitimately uses supabase-js through @/lib/supabase/client.
    // What must not be reachable is a module that names the service-role
    // credential. That is the next test; this one pins the one legitimate door.
    const clientHelper = join(SRC, 'lib/supabase/client.ts')
    assert.ok(existsSync(clientHelper), 'the browser Supabase helper exists')
    assert.equal(readFileSync(clientHelper, 'utf8').includes('SERVICE_ROLE'), false)
  })
})

// ── 2. No service-role environment variable can enter a client bundle ────────

describe('the credential cannot enter a client bundle', () => {
  test('no module reachable from a client component names SUPABASE_SERVICE_ROLE_KEY', () => {
    const offenders: string[] = []
    for (const entry of CLIENT_FILES) {
      for (const [file, path] of graphFor(entry)) {
        if (readFileSync(file, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY')) {
          offenders.push(path.map(rel).join('\n    -> '))
        }
      }
    }
    assert.deepEqual(offenders, [], `credential reachable via:\n    ${offenders.join('\n\n    ')}`)
  })

  test('and no CREDENTIAL-shaped env name is reachable from a browser either', () => {
    // Broader than the one name above, because the next privileged variable
    // will not be called SUPABASE_SERVICE_ROLE_KEY. Next inlines only
    // NEXT_PUBLIC_* into a client bundle, so any of these reaching a browser is
    // both useless there and a sign somebody imported the wrong module.
    //
    // NOT asserted: that EVERY non-public name is unreachable. `BOE_PERF_DEBUG`
    // is read by src/lib/perf.ts, which is reachable from the notification
    // screens. It is a debug flag rather than a secret, and because it is not
    // NEXT_PUBLIC_ it reads as undefined in the browser — so that flag simply
    // cannot be turned on client-side. Pre-existing, harmless, and not this
    // hotfix's to change; recorded here so the next reader does not rediscover
    // it as a finding.
    const CREDENTIAL = /(SERVICE_ROLE|SECRET|PASSWORD|_TOKEN|_KEY)/
    const offenders: string[] = []
    for (const entry of CLIENT_FILES) {
      for (const [file, path] of graphFor(entry)) {
        const text = readFileSync(file, 'utf8')
        for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
          if (m[1].startsWith('NEXT_PUBLIC_')) continue
          if (CREDENTIAL.test(m[1])) offenders.push(`${m[1]} via ${path.map(rel).join(' -> ')}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })
})

// ── 3. The two halves are actually separate ──────────────────────────────────

describe('the split is real, and points one way only', () => {
  const browserSrc = readFileSync(join(SRC, 'lib/tasks/assignmentNotification.ts'), 'utf8')
  const writerSrc  = readFileSync(WRITER, 'utf8')

  test('the browser half writes nothing and knows no credential', () => {
    assert.equal(/\.from\(['"]notifications['"]\)/.test(browserSrc), false)
    assert.equal(browserSrc.includes('process.env'), false)
    assert.equal(browserSrc.includes('supabase-js'), false)
    assert.equal(browserSrc.includes('SERVICE_ROLE'), false)
  })

  test('the browser half does NOT import the writer', () => {
    // The filename appears in a comment pointing readers at it, which is
    // wanted. What must not exist is an import or re-export of it.
    assert.equal(/(?:from|import\()\s*['"][^'"]*assignmentNotificationWriter/.test(browserSrc), false)
  })

  test('the writer imports the browser half, which is the allowed direction', () => {
    assert.ok(writerSrc.includes("from './assignmentNotification'"))
  })

  test('the writer is named so the boundary is visible without opening it', () => {
    assert.ok(WRITER.endsWith('.server.ts'))
  })

  test('the writer carries no `use client` directive', () => {
    assert.equal(/^\s*['"]use client['"]/m.test(writerSrc.slice(0, 400)), false)
  })

  test('the four creation screens import only the browser half', () => {
    for (const path of [
      'src/app/tasks/create/page.tsx',
      'src/app/tasks/assigned-by-me/page.tsx',
      'src/app/tasks/quotation-requests/new/page.tsx',
      'src/components/meetings/MeetingTaskModal.tsx',
    ]) {
      const text = readFileSync(join(ROOT, path), 'utf8')
      assert.ok(text.includes("from '@/lib/tasks/assignmentNotification'"), `${path} imports the browser half`)
      assert.equal(/assignmentNotificationWriter/.test(text), false,
        `${path} must not import the writer`)
    }
  })
})
