/**
 * SALES STARTS ITS PAGE WHILE THE PERMISSION ANSWER IS ON ITS WAY (2026-11-23, page speed).
 *
 * The guard's own behaviour is tested in src/components/layout/moduleGuardStartsEarly.dom.test.tsx and the wiring in
 * src/lib/tasks/startDuringCheckTasks.test.ts. This file holds the audit that makes the hidden build safe for Sales: while
 * the page is hidden, anything it does on opening beyond READING must wait for useModuleShown(). A Sales read is a database
 * function that checks the caller itself, so starting it early gives nothing to somebody the guard turns away; a write on
 * mount would still happen for them, so the scan below fails if an effect in the Sales tree writes and nobody has said how
 * it waits.
 *
 * Run: npx tsx --test src/components/salesLeads/startDuringCheckSales.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function files(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  if (!statSync(abs).isDirectory()) { out.push(dir); return out }
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(rel)
  }
  return out
}

describe('the pages that read as soon as they are built', () => {
  test('My day, the Lead Master and the Team page do not hold their reads back for the permission answer', () => {
    for (const f of ['MyDayScreen', 'LeadMasterScreen', 'TeamScreen']) {
      const src = codeOf(read(`src/components/salesLeads/${f}.tsx`))
      assert.ok(!/enabled:\s*ready\s*,/.test(src), `${f} still holds a read back with enabled: ready`)
    }
  })

  test('what needs to know who may do it still waits: the held-chats count, and the Team reads for somebody the answer says is not a manager', () => {
    assert.ok(codeOf(read('src/components/salesLeads/LeadMasterScreen.tsx')).includes('enabled: ready && canAssign'))
    const team = codeOf(read('src/components/salesLeads/TeamScreen.tsx'))
    assert.ok(team.includes('const mayRead = !ready || canSeeAll'))
    assert.equal((team.match(/enabled: mayRead/g) ?? []).length, 3)
  })
})

describe('the audit: no effect in the Sales tree writes without being accounted for', () => {
  // Every effect body in the Sales pages, shell and components that does one of these. A read is fine while hidden: it only starts sooner.
  const WRITES = /\.(insert|update|upsert|delete)\(|method:\s*'(POST|PUT|PATCH|DELETE)'|sendBeacon|\.mutate\(|mutateAsync\(|\.rpc\(/
  const SCOPE = [
    'src/app/sales', 'src/components/salesLeads', 'src/components/layout/SalesLayout.tsx', 'src/components/notifications',
    'src/hooks/useSalesAccess.ts', 'src/hooks/queries/useUnreadNotifications.ts',
  ]
  // Each entry says HOW it is safe while the page is hidden. Add one only after reading the effect.
  const ACCOUNTED_FOR: Record<string, string> = {}

  function effectsThatWrite(): string[] {
    const hits = new Set<string>()
    for (const f of SCOPE.flatMap(d => files(d))) {
      const src = read(f)
      const re = /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\{/g
      while (re.exec(src) !== null) {
        let i = re.lastIndex
        let depth = 1
        while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++ }
        if (WRITES.test(codeOf(src.slice(re.lastIndex, i - 1)))) hits.add(f)
      }
    }
    return [...hits].sort()
  }

  test('every effect that writes is listed, with the reason it is safe', () => {
    const unknown = effectsThatWrite().filter(f => !(f in ACCOUNTED_FOR))
    assert.deepEqual(unknown, [],
      'an effect in the Sales tree now writes on mount: while the guard builds the page hidden it would run for '
      + 'somebody the guard turns away. Make it wait for useModuleShown(), then list it in ACCOUNTED_FOR with the reason.')
  })

  test('the list stays honest: every entry still has such an effect', () => {
    const found = new Set(effectsThatWrite())
    for (const f of Object.keys(ACCOUNTED_FOR)) assert.ok(found.has(f), `${f} no longer has a writing effect: remove it from ACCOUNTED_FOR`)
  })
})
