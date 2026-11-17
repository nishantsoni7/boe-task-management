/**
 * Daily splash — what it shows, and that it stops repeating.
 *
 * The splash used to be 1 of 50 fixed quotes chosen by the day of the year: the
 * same line for everyone, the list back every 50 days. These tests pin the
 * replacement: a library of 300+ lines, drawn without repeats per browser, never
 * the same kind two days running, with an optional news headline that can only
 * ever be a bonus (every storage or network failure falls back to the library).
 *
 * Run:
 *   npx tsx --test src/lib/dailySplash/dailySplash.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SPLASH_CHARS, SPLASH_ITEMS, SPLASH_LABEL, type SplashItem } from './items'
import {
  HEADLINES_KEY, LOADER_LINE_COUNT, SPLASH_STATE_KEY, chooseTodaysSplash, cleanHeadlineList, drawLoaderLines,
  pickSplash, readHeadlines, refreshHeadlines, splashDurationMs, splashId, type SplashState, type StorageLike,
} from './splash'

// A small seeded generator (mulberry32) so the "random" draws are repeatable.
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}

const NOW = Date.UTC(2026, 10, 18, 4, 0, 0)
const news = (title: string): SplashItem => ({ kind: 'news', text: title, by: 'The Hindu' })

describe('the library', () => {
  test('has at least 300 lines and no repeated line', () => {
    assert.ok(SPLASH_ITEMS.length >= 300, `only ${SPLASH_ITEMS.length} lines`)
    const texts = SPLASH_ITEMS.map(i => i.text.toLowerCase())
    assert.equal(new Set(texts).size, texts.length, 'a line appears twice')
    const ids = SPLASH_ITEMS.map(splashId)
    assert.equal(new Set(ids).size, ids.length, 'two lines share an id')
  })

  test('every kind has a real share, and news is not hard-coded', () => {
    const counts = new Map<string, number>()
    for (const i of SPLASH_ITEMS) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1)
    for (const kind of ['fact', 'boe', 'work', 'oneliner', 'jingle', 'motivation']) {
      assert.ok((counts.get(kind) ?? 0) >= 30, `${kind} has ${counts.get(kind)} lines`)
    }
    assert.equal(counts.get('news') ?? 0, 0)
    for (const kind of Object.keys(SPLASH_LABEL)) assert.ok(SPLASH_LABEL[kind as keyof typeof SPLASH_LABEL].length > 0)
  })

  test('every line fits the splash and is tidy', () => {
    for (const i of SPLASH_ITEMS) {
      assert.ok(i.text.length >= 10 && i.text.length <= MAX_SPLASH_CHARS, `"${i.text}" is ${i.text.length} chars`)
      assert.equal(i.text, i.text.trim())
      assert.ok(!/\s{2,}/.test(i.text), `double space in "${i.text}"`)
      assert.ok(!/—|–/.test(i.text), `dash character in "${i.text}"`)
    }
  })

  test('only named quotes carry an author', () => {
    for (const i of SPLASH_ITEMS.filter(x => x.by)) {
      assert.equal(i.kind, 'motivation')
    }
    assert.deepEqual(
      SPLASH_ITEMS.filter(x => x.by).map(x => x.by).sort(),
      ['Benjamin Franklin', 'Lao Tzu', 'Thomas Edison'],
    )
  })
})

describe('drawing without repeats', () => {
  function drawAll(count: number, seed: number, newsItems: SplashItem[] = []) {
    const rand = seeded(seed)
    let state: SplashState = { seen: [], newsSeen: [], lastKind: null }
    const shown: SplashItem[] = []
    for (let i = 0; i < count; i++) {
      const out = pickSplash(SPLASH_ITEMS, newsItems, state, rand)
      shown.push(out.item)
      state = out.state
    }
    return { shown, state }
  }

  test('no line repeats until the whole library has been shown', () => {
    const { shown } = drawAll(SPLASH_ITEMS.length, 1)
    const ids = shown.map(splashId)
    assert.equal(new Set(ids).size, SPLASH_ITEMS.length, 'a line repeated inside one lap')
  })

  test('after a full lap the next lap starts, and again has no repeats', () => {
    const lap = SPLASH_ITEMS.length
    const { shown, state } = drawAll(lap + 5, 2)
    assert.equal(state.seen.length, 5, 'the lap counter restarted')
    const secondLap = shown.slice(lap).map(splashId)
    assert.equal(new Set(secondLap).size, 5)
  })

  test('the same kind never shows two days running', () => {
    const { shown } = drawAll(SPLASH_ITEMS.length, 3)
    for (let i = 1; i < shown.length; i++) {
      if (shown[i].kind === shown[i - 1].kind) {
        // Only possible once every other kind has run out, at the very end of a lap.
        const rest = new Set(shown.slice(i).map(x => x.kind))
        assert.equal(rest.size, 1, `two ${shown[i].kind} lines in a row at day ${i} with other kinds left`)
      }
    }
  })

  test('different people get different orders', () => {
    const a = drawAll(12, 11).shown.map(splashId)
    const b = drawAll(12, 12).shown.map(splashId)
    assert.notDeepEqual(a, b)
  })

  test('the first month is varied: at least five kinds', () => {
    const kinds = new Set(drawAll(30, 4).shown.map(i => i.kind))
    assert.ok(kinds.size >= 5, `only ${[...kinds].join(', ')}`)
  })

  test('ids remembered for lines that no longer exist are ignored, not fatal', () => {
    const out = pickSplash(SPLASH_ITEMS, [], { seen: ['fact:gone', 'x'], newsSeen: [], lastKind: null }, seeded(5))
    assert.ok(out.item)
    assert.ok(!out.state.seen.includes('fact:gone'))
  })
})

describe('the news headline', () => {
  test('a fresh headline can appear, once, and is then remembered', () => {
    const headline = news('A new phone launches in India today with a bigger battery')
    const rand = seeded(7)
    let state: SplashState = { seen: [], newsSeen: [], lastKind: null }
    let timesShown = 0
    for (let day = 0; day < 200; day++) {
      const out = pickSplash(SPLASH_ITEMS, [headline], state, rand)
      if (out.item.kind === 'news') timesShown++
      state = out.state
    }
    assert.equal(timesShown, 1, 'a headline is shown once, not on a loop')
  })

  test('a headline is stored, read back with its publisher, and expires after three days', () => {
    const storage = memoryStorage({
      [HEADLINES_KEY]: JSON.stringify({ at: NOW, items: [{ title: 'Cricket: a record chase in Chennai', source: 'The Hindu' }] }),
    })
    const fresh = readHeadlines(storage, NOW + 2 * 86_400_000)
    assert.deepEqual(fresh, [{ kind: 'news', text: 'Cricket: a record chase in Chennai', by: 'The Hindu' }])
    assert.deepEqual(readHeadlines(storage, NOW + 4 * 86_400_000), [], 'old news is not trending')
  })

  test('cleanHeadlineList keeps only well-formed, short entries', () => {
    const long = 'x'.repeat(111)
    assert.deepEqual(
      cleanHeadlineList([
        { title: 'Good one', source: 'BBC News' },
        { title: long, source: 'BBC News' },
        { title: 'No source' },
        { title: 5, source: 'x' },
        null,
        'text',
        { title: 'Source too long', source: 'y'.repeat(41) },
      ]),
      [{ title: 'Good one', source: 'BBC News' }],
    )
    assert.deepEqual(cleanHeadlineList('nope'), [])
    assert.equal(cleanHeadlineList(Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, source: 's' }))).length, 12)
  })
})

describe('chooseTodaysSplash and storage', () => {
  test('remembers what it showed, so tomorrow is a different line', () => {
    const storage = memoryStorage()
    const first = chooseTodaysSplash(storage, seeded(21), NOW)
    const saved = JSON.parse(storage.data[SPLASH_STATE_KEY]) as SplashState
    assert.deepEqual(saved.seen, [splashId(first)])
    assert.equal(saved.lastKind, first.kind)
    const second = chooseTodaysSplash(storage, seeded(21), NOW)
    assert.notEqual(splashId(second), splashId(first))
    assert.notEqual(second.kind, first.kind)
  })

  test('uses a stored headline when there is one', () => {
    const storage = memoryStorage({
      [HEADLINES_KEY]: JSON.stringify({ at: NOW, items: [{ title: 'Cricket: a record chase in Chennai', source: 'The Hindu' }] }),
    })
    let sawNews = false
    for (let seed = 1; seed < 80 && !sawNews; seed++) {
      const s = memoryStorage({ ...storage.data })
      sawNews = chooseTodaysSplash(s, seeded(seed), NOW).kind === 'news'
    }
    assert.ok(sawNews, 'a stored headline should be able to appear')
  })

  test('no storage, throwing storage and corrupt storage all still give a line', () => {
    assert.ok(chooseTodaysSplash(null, seeded(1), NOW).text)
    const throwing: StorageLike = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    assert.ok(chooseTodaysSplash(throwing, seeded(1), NOW).text)
    const corrupt = memoryStorage({ [SPLASH_STATE_KEY]: '{not json', [HEADLINES_KEY]: '[1,2' })
    assert.ok(chooseTodaysSplash(corrupt, seeded(1), NOW).text)
    const wrongShape = memoryStorage({ [SPLASH_STATE_KEY]: JSON.stringify({ seen: 'x', newsSeen: 4, lastKind: 'banana' }) })
    assert.ok(chooseTodaysSplash(wrongShape, seeded(1), NOW).text)
  })
})

describe('refreshHeadlines', () => {
  const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

  test('stores a good answer', async () => {
    const storage = memoryStorage()
    let calls = 0
    await refreshHeadlines(storage, (async (url: string) => {
      calls++
      assert.equal(url, '/api/daily-headlines')
      return okResponse({ items: [{ title: 'Gadgets: a thinner laptop arrives', source: 'Gadgets 360' }] })
    }) as unknown as typeof fetch, NOW)
    assert.equal(calls, 1)
    assert.equal(readHeadlines(storage, NOW).length, 1)
  })

  test('does not ask again within six hours, asks again after', async () => {
    const storage = memoryStorage({
      [HEADLINES_KEY]: JSON.stringify({ at: NOW, items: [{ title: 'Already stored headline here', source: 'BBC News' }] }),
    })
    let calls = 0
    const f = (async () => { calls++; return okResponse({ items: [{ title: 'A newer headline arrives today', source: 'BBC News' }] }) }) as unknown as typeof fetch
    await refreshHeadlines(storage, f, NOW + 5 * 3_600_000)
    assert.equal(calls, 0)
    await refreshHeadlines(storage, f, NOW + 7 * 3_600_000)
    assert.equal(calls, 1)
  })

  test('a failed, refused, empty or garbled answer changes nothing and throws nothing', async () => {
    const storage = memoryStorage()
    await refreshHeadlines(storage, (async () => { throw new Error('offline') }) as unknown as typeof fetch, NOW)
    await refreshHeadlines(storage, (async () => ({ ok: false })) as unknown as typeof fetch, NOW)
    await refreshHeadlines(storage, (async () => okResponse({ items: [] })) as unknown as typeof fetch, NOW)
    await refreshHeadlines(storage, (async () => okResponse('garbage')) as unknown as typeof fetch, NOW)
    await refreshHeadlines(storage, (async () => ({ ok: true, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch, NOW)
    assert.deepEqual(storage.data, {})
  })
})

describe('drawLoaderLines (the BOE One loader)', () => {
  test('eight different lines, none of the same kind twice in a row, all short enough for the loader', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const lines = drawLoaderLines([], seeded(seed))
      assert.equal(lines.length, LOADER_LINE_COUNT)
      assert.equal(new Set(lines.map(l => l.text)).size, 8, 'a line twice in one showing')
      for (let i = 0; i < lines.length; i++) {
        assert.ok(lines[i].text.length <= MAX_SPLASH_CHARS)
        if (i > 0) assert.notEqual(lines[i].kind, lines[i - 1].kind, `seed ${seed}: two ${lines[i].kind} lines in a row`)
      }
    }
  })

  test('every showing is different: the same two sentences are not all anyone sees', () => {
    const firstLines = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) firstLines.add(drawLoaderLines([], seeded(seed))[0].text)
    assert.ok(firstLines.size >= 40, `only ${firstLines.size} different first lines in 60 showings`)
  })

  test('the first line is not always the same kind', () => {
    const kinds = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) kinds.add(drawLoaderLines([], seeded(seed))[0].kind)
    assert.ok(kinds.size >= 5, `only ${[...kinds].join(', ')}`)
  })

  test('a headline joins the draw, with its publisher, and at most once per showing', () => {
    const headline = news('A thinner laptop arrives with a brighter screen')
    let showings = 0
    for (let seed = 1; seed <= 80; seed++) {
      const lines = drawLoaderLines([headline], seeded(seed))
      const found = lines.filter(l => l.kind === 'news')
      assert.ok(found.length <= 1)
      if (found.length) {
        showings++
        assert.equal(found[0].by, 'The Hindu')
      }
    }
    assert.ok(showings >= 20, `a headline appeared in only ${showings} of 80 showings`)
  })

  test('without a headline, there is never an "In the news" line', () => {
    for (let seed = 1; seed <= 30; seed++) {
      assert.ok(!drawLoaderLines([], seeded(seed)).some(l => l.kind === 'news'))
    }
  })
})

describe('splashDurationMs', () => {
  const at = (n: number): SplashItem => ({ kind: 'fact', text: 'x'.repeat(n) })

  test('a short line keeps the original 2.5 seconds', () => {
    assert.equal(splashDurationMs(at(20)), 2500)
    assert.equal(splashDurationMs(at(60)), 2500)
  })

  test('a longer line stays longer, up to a ceiling of 4.5 seconds', () => {
    assert.equal(splashDurationMs(at(100)), 4100)
    assert.equal(splashDurationMs(at(140)), 4500)
    assert.equal(splashDurationMs(at(400)), 4500)
  })

  test('every line in the library fits inside the ceiling', () => {
    for (const i of SPLASH_ITEMS) {
      const ms = splashDurationMs(i)
      assert.ok(ms >= 2500 && ms <= 4500)
    }
  })
})
