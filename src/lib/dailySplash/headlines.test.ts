/**
 * Daily splash headlines — reading public RSS safely.
 *
 * Run:
 *   npx tsx --test src/lib/dailySplash/headlines.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FEEDS, fetchHeadlines, isCleanHeadline, parseRssTitles } from './headlines'
import { GET } from '../../app/api/daily-headlines/route'

const rss = (titles: string[], channelTitle = 'The Channel Name') =>
  `<?xml version="1.0"?><rss><channel><title>${channelTitle}</title>${titles
    .map(t => `<item><title>${t}</title><link>https://example.test/${encodeURIComponent(t)}</link></item>`)
    .join('')}</channel></rss>`

const xmlResponse = (xml: string) => ({ ok: true, text: async () => xml }) as unknown as Response

describe('parseRssTitles', () => {
  test('reads item titles only, not the channel title', () => {
    assert.deepEqual(parseRssTitles(rss(['First story here', 'Second story here'])), ['First story here', 'Second story here'])
  })

  test('handles CDATA, entities and stray whitespace', () => {
    const xml = rss([
      '<![CDATA[ Tom &amp; Jerry   return  ]]>',
      'It&#8217;s a &quot;big&quot; win &#x2019;',
      'Unknown &nbsp;&bogus; entity stays',
    ])
    assert.deepEqual(parseRssTitles(xml), [
      'Tom & Jerry return',
      'It’s a "big" win ’',
      'Unknown &bogus; entity stays',
    ])
  })

  test('an impossible numeric entity is left alone instead of throwing', () => {
    assert.deepEqual(parseRssTitles(rss(['Odd &#99999999; code'])), ['Odd &#99999999; code'])
  })

  test('honours the limit and survives junk', () => {
    assert.equal(parseRssTitles(rss(Array.from({ length: 50 }, (_, i) => `Story number ${i}`)), 5).length, 5)
    assert.deepEqual(parseRssTitles('not xml at all'), [])
    assert.deepEqual(parseRssTitles(''), [])
  })
})

describe('isCleanHeadline', () => {
  test('lets ordinary tech, business, cricket and entertainment headlines through', () => {
    for (const t of [
      'ISRO unveils a new satellite to bring faster internet to villages',
      'A budget phone with a 50-hour battery launches in India',
      'India clinch the series with a record chase in Chennai',
      'Startup raises funds to make furniture shipping cheaper',
    ]) assert.equal(isCleanHeadline(t), true, t)
  })

  test('refuses grim, political and work-unfriendly headlines', () => {
    for (const t of [
      'Sensex crashes 900 points as investors panic over weak results',
      'Three killed after a bus overturns on the highway near the city',
      'Opposition leaders attack the government over the new bill today',
      'Modi to address the nation about the new economic policy',
      'Tech giant announces layoffs for thousands of employees worldwide',
      'Hackers breach a major bank and leak customer details online',
      'Election results: the counting begins early tomorrow morning',
      'Actor arrested over a scam involving a jewellery brand',
      'Rupee rises 43 paise to close at 93.51 (provisional) against U.S. dollar',
      'What to know about the online banking delays affecting major banks',
      'Singapore seeks trusted access to AI chips after new US curbs',
    ]) assert.equal(isCleanHeadline(t), false, t)
  })

  test('refuses the kinds of headline a live read of the feeds let through at first', () => {
    for (const t of [
      'What is Megaspeed International, the firm under scanner over Nvidia CEO affair',
      'Who is Jensen Huang and how the timeline of spy scandal unfolded',
      'Wholesale inflation rises to 12.3% in October, a second straight month',
      'Warner accuses Cricket Australia of cover-up over Sandpapergate',
      'Lakshya Raichandani dedicates U19 Asia Cup glory to his late coach',
      'Karnataka charting next tech leap to push AI, deep-tech: CM D.K. Shivakumar',
      'Bitcoin Trades Near $65,000 as Options Traders Seek Downside Protection',
      'Sir Tom Jones announces homecoming gigs after cancelling shows due to flu',
      'Export duty on diesel hiked by Rs 2.5 a litre, petrol remains nil',
      'Jordan blocks Telegram app over national security concerns',
      'Military-linked Chinese university bought chips despite a US blacklist',
    ]) assert.equal(isCleanHeadline(t), false, t)
  })

  test('still lets the cheerful ones through: gadgets, cricket, films, music', () => {
    for (const t of [
      'Xiaomi Smart Band 11 Launched With 1.72-Inch AMOLED Display, Over 150 Sports Modes',
      'WhatsApp Rolling Out Cloud Storage for Chat Backups on Android: Report',
      'Dhoni ends IPL playing career as CSK appoints him team mentor',
      'Robert Pattinson to replace Daniel Craig as James Bond',
      'Raye, Rosalia and Dolly Parton recognised in Grammy nominations',
    ]) assert.equal(isCleanHeadline(t), true, t)
  })

  test('refuses headlines that are too short, too long, shouting, or fragments', () => {
    assert.equal(isCleanHeadline('Short one'), false)
    assert.equal(isCleanHeadline('x'.repeat(101)), false)
    assert.equal(isCleanHeadline('THIS HEADLINE IS ALL IN CAPITAL LETTERS TODAY'), false)
    assert.equal(isCleanHeadline('Cricket highlights | Day three of the match'), false)
    assert.equal(isCleanHeadline('Live blog: day three of the match in Chennai'), false)
    assert.equal(isCleanHeadline('Here is what happens next in the series:'), false)
  })
})

describe('the feeds', () => {
  test('are public https feeds from named publishers, and none is a business-market feed', () => {
    assert.ok(FEEDS.length >= 4)
    for (const f of FEEDS) {
      assert.match(f.url, /^https:\/\//)
      assert.ok(f.source.length > 0 && f.source.length <= 40)
      assert.ok(!/business|market|stock/i.test(f.url), f.url)
    }
  })
})

describe('fetchHeadlines', () => {
  const feeds = [
    { source: 'A Paper', url: 'https://a.example/rss' },
    { source: 'B Paper', url: 'https://b.example/rss' },
    { source: 'C Paper', url: 'https://c.example/rss' },
  ]

  test('mixes the feeds, labels each with its publisher, and drops the unwanted', async () => {
    const out = await fetchHeadlines((async (url: string) => {
      if (url.startsWith('https://a.')) return xmlResponse(rss(['A new phone launches in India with a big battery', 'Man killed in a road accident last night near town']))
      if (url.startsWith('https://b.')) return xmlResponse(rss(['A thinner laptop arrives with a brighter screen', 'India clinch the series with a record chase']))
      throw new Error('feed C is down')
    }) as unknown as typeof fetch, feeds)
    assert.deepEqual(out.map(h => h.source), ['A Paper', 'B Paper', 'B Paper'])
    assert.ok(!out.some(h => /killed/.test(h.title)))
    assert.equal(out[0].title, 'A new phone launches in India with a big battery')
  })

  test('removes the same headline carried by two feeds, and caps the list at 12', async () => {
    const same = 'A thinner laptop arrives with a brighter screen'
    const many = Array.from({ length: 30 }, (_, i) => `Gadget number ${i} arrives with a brighter screen`)
    const out = await fetchHeadlines((async (url: string) => xmlResponse(rss(url.startsWith('https://a.') ? [same, ...many] : [same.toLowerCase(), ...many]))) as unknown as typeof fetch, feeds)
    assert.equal(out.length, 12)
    assert.equal(out.filter(h => h.title.toLowerCase() === same.toLowerCase()).length, 1)
  })

  test('a refused or empty feed leaves the others working; all failing gives an empty list', async () => {
    const out = await fetchHeadlines((async () => ({ ok: false })) as unknown as typeof fetch, feeds)
    assert.deepEqual(out, [])
  })

  test('asks politely: a timeout, an hourly cache, and a user agent that says nothing about us', async () => {
    let seen: RequestInit | undefined
    await fetchHeadlines((async (_url: string, init?: RequestInit) => { seen = init; return xmlResponse(rss([])) }) as unknown as typeof fetch, [feeds[0]])
    assert.ok(seen?.signal, 'no timeout signal')
    assert.deepEqual((seen as { next?: unknown }).next, { revalidate: 3600 })
    const ua = (seen?.headers as Record<string, string>)['User-Agent']
    assert.ok(ua && !/boe/i.test(ua), `user agent "${ua}" must not name the app`)
  })
})

describe('GET /api/daily-headlines', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  test('answers with headlines and an hour of edge cache', async () => {
    globalThis.fetch = (async () => xmlResponse(rss(['A thinner laptop arrives with a brighter screen']))) as unknown as typeof fetch
    const res = await GET()
    const body = (await res.json()) as { items: { title: string; source: string }[] }
    assert.equal(res.status, 200)
    assert.ok(body.items.length >= 1)
    assert.match(res.headers.get('cache-control') ?? '', /s-maxage=3600/)
  })

  test('when every feed fails it answers an empty list that is cached only briefly', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const res = await GET()
    assert.deepEqual(await res.json(), { items: [] })
    assert.match(res.headers.get('cache-control') ?? '', /s-maxage=300/)
  })
})
