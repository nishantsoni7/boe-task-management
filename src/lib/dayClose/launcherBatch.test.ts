// THE SERVER'S HALF OF THE LAUNCHER BATCH (2026-11-14, page speed part 6): the same four loaders, one caller
// check, each answer exactly as its own route would send it, one failing part never taking the others down.
// Run with: npx tsx --test src/lib/dayClose/launcherBatch.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { LAUNCHER_PARTS, loadLauncher, parseLauncherParts, type LauncherLoaders } from './launcherBatch'

const caller = { id: 'u1' } as unknown as Caller
const ok = (body: Record<string, unknown>, status = 200) => ({ status, body })

describe('which parts are asked for', () => {
  test('the named parts, once each, in the canonical order; anything else is ignored', () => {
    assert.deepEqual(parseLauncherParts('me,prompt'), ['prompt', 'me'])
    assert.deepEqual(parseLauncherParts('vote, starSeller ,vote,hacker,'), ['vote', 'starSeller'])
    assert.deepEqual(parseLauncherParts(null), [])
    assert.deepEqual(parseLauncherParts(''), [])
    assert.deepEqual(parseLauncherParts(LAUNCHER_PARTS.join(',')), [...LAUNCHER_PARTS])
  })
})

describe('what the batch answers', () => {
  const loaders = (overrides: Partial<LauncherLoaders> = {}): LauncherLoaders => ({
    prompt: async () => ok({ today: '2026-11-14', prompt: { kind: 'none' } }),
    me: async () => ok({ scored: false }),
    vote: async () => ok({ error: 'Day Close is not switched on for you.' }, 403),
    starSeller: async () => ok({ seller: null }),
    ...overrides,
  })

  test('each part carries its own loader\'s status and body, unchanged', async () => {
    const r = await loadLauncher(caller, ['prompt', 'me', 'vote', 'starSeller'], loaders())
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { parts: {
      prompt: ok({ today: '2026-11-14', prompt: { kind: 'none' } }),
      me: ok({ scored: false }),
      vote: ok({ error: 'Day Close is not switched on for you.' }, 403),
      starSeller: ok({ seller: null }),
    } })
  })

  test('only the parts asked for are run, for the caller given', async () => {
    const seen: string[] = []
    const spy = (name: string) => async (c: Caller) => { seen.push(`${name}:${(c as unknown as { id: string }).id}`); return ok({}) }
    await loadLauncher(caller, ['me', 'vote'], loaders({ me: spy('me'), vote: spy('vote'), prompt: spy('prompt'), starSeller: spy('star') }))
    assert.deepEqual(seen.sort(), ['me:u1', 'vote:u1'])
  })

  test('the parts run in parallel, not one after another', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow = (name: string) => async () => { order.push(`start ${name}`); await gate; order.push(`end ${name}`); return ok({}) }
    const run = loadLauncher(caller, ['prompt', 'me', 'vote', 'starSeller'], loaders({
      prompt: slow('prompt'), me: slow('me'), vote: slow('vote'), starSeller: slow('starSeller'),
    }))
    await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(order, ['start prompt', 'start me', 'start vote', 'start starSeller'], 'all four started before any ended')
    release()
    await run
  })

  test('a part that throws becomes that route\'s own 500 answer and the others still answer', async () => {
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const r = await loadLauncher(caller, ['prompt', 'me'], loaders({ me: async () => { throw new Error('db down: secret detail') } }))
      assert.deepEqual((r.body as { parts: Record<string, unknown> }).parts, {
        prompt: ok({ today: '2026-11-14', prompt: { kind: 'none' } }),
        me: { status: 500, body: { error: 'Something went wrong. Try again.' } },
      })
      assert.equal(JSON.stringify(r).includes('secret detail'), false, 'the database message stays in the server log')
      assert.equal(logged.length, 1)
    } finally {
      console.error = original
    }
  })

  test('no parts asked for is an empty answer, not an error', async () => {
    assert.deepEqual(await loadLauncher(caller, [], loaders()), { status: 200, body: { parts: {} } })
  })
})

describe('the route and the wiring', () => {
  const root = join(__dirname, '..', '..', '..')
  // Line comments first: a header comment that mentions "/api/day-close/*" must not open a block comment.
  const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

  test('the batch route runs the SAME four loaders as the four routes it replaces, behind the same caller check', () => {
    const batch = src('src/app/api/day-close/launcher/route.ts')
    assert.match(batch, /dayCloseRoute\(req, 'launcher'/)
    for (const [loader, route] of [
      ['loadMyPrompt', 'src/app/api/day-close/prompt/route.ts'],
      ['loadMyScore', 'src/app/api/scoreboard/me/route.ts'],
      ['loadVote', 'src/app/api/scoreboard/vote/route.ts'],
      ['loadStarSeller', 'src/app/api/scoreboard/star-seller/route.ts'],
    ]) {
      assert.ok(batch.includes(`${loader}(c)`), `${loader} is a part of the batch`)
      assert.ok(src(route).includes(`${loader}(caller)`), `${route} still answers with ${loader}`)
    }
    assert.match(batch, /export async function GET/)
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(batch), false, 'a batch of reads only')
  })

  test('the four routes still exist (the fallback)', () => {
    for (const r of ['day-close/prompt', 'scoreboard/me', 'scoreboard/vote', 'scoreboard/star-seller']) {
      assert.ok(existsSync(join(root, 'src/app/api', r, 'route.ts')), r)
    }
  })

  test('the cards ask through the batcher and nothing fetches the four routes around it', () => {
    assert.match(src('src/components/dayClose/api.ts'), /batchedGet\(path\)/)
    assert.match(src('src/hooks/queries/useDayPrompt.ts'), /batchedGet\('\/api\/day-close\/prompt'\)/)
    assert.equal(/fetch\(\s*['"]\/api\/day-close\/prompt/.test(src('src/hooks/queries/useDayPrompt.ts')), false)
  })
})
