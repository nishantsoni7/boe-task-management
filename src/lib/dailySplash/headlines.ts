// "In the news": one short, upbeat headline for the splash, server side.
//
// Read from the publishers' own public RSS feeds (no key, no cost, no AI), kept
// to tech, gadgets, cricket and entertainment (a business feed was tried and
// dropped: it is market ticks), and filtered so nothing grim or political lands
// on the first screen of the working day. The filter is a
// keyword list: it catches the obvious, not everything. That is why this is
// only ONE kind of seven, and why the library is the fallback.
//
// shortcut: RSS read with a regex, not an XML parser. These feeds are flat
// <item><title> lists; upgrade to a parser if a feed ever nests titles.

export type Headline = { title: string; source: string }

export const FEEDS: readonly { source: string; url: string }[] = [
  { source: 'The Hindu', url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss' },
  { source: 'The Hindu', url: 'https://www.thehindu.com/sport/cricket/feeder/default.rss' },
  { source: 'The Hindu', url: 'https://www.thehindu.com/entertainment/movies/feeder/default.rss' },
  { source: 'Gadgets 360', url: 'https://feeds.feedburner.com/gadgets360-latest' },
  { source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml' },
]

const MIN_CHARS = 30
const MAX_CHARS = 100
const KEPT = 12

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

/** The item titles of an RSS document, in order, cleaned of CDATA and entities. */
export function parseRssTitles(xml: string, max = 30): string[] {
  const out: string[] = []
  const items = /<item[\s>][\s\S]*?<\/item>/g
  let m: RegExpExecArray | null
  while ((m = items.exec(xml)) !== null && out.length < max) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[0])
    if (!t) continue
    const title = decodeEntities(t[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'))
      .replace(/\s+/g, ' ')
      .trim()
    if (title) out.push(title)
  }
  return out
}

// Grim, political, or work-unfriendly. Whole words (and a few stems) only.
const UNWANTED = new RegExp(
  '\\b(' + [
    'dead', 'death\\w*', 'dies', 'died', 'dying', 'kill\\w*', 'murder\\w*', 'rape\\w*', 'suicid\\w*',
    'shot', 'shoot\\w*', 'stab\\w*', 'attack\\w*', 'terror\\w*', 'bomb\\w*', 'blast\\w*', 'wars?', 'missile\\w*',
    'strikes?', 'crash\\w*', 'collaps\\w*', 'flood\\w*', 'earthquake\\w*', 'cyclone\\w*', 'storm\\w*',
    'disaster\\w*', 'tragedy', 'tragic', 'victim\\w*', 'injur\\w*', 'fatal\\w*', 'drown\\w*', 'funeral\\w*',
    'mourn\\w*', 'condolence\\w*', 'obituary', 'toll', 'hostage\\w*', 'riot\\w*', 'protest\\w*', 'lynch\\w*',
    'arrest\\w*', 'jail\\w*', 'prison\\w*', 'scam\\w*', 'fraud\\w*', 'breach\\w*', 'ransom\\w*', 'hack\\w*',
    'abuse\\w*', 'assault\\w*', 'harass\\w*', 'molest\\w*', 'racis\\w*', 'sexual\\w*', 'porn\\w*', 'dowry',
    'election\\w*', 'vote\\w*', 'voters?', 'polls?', 'bjp', 'congress', 'modi', 'trump', 'biden', 'putin',
    'gaza', 'israel\\w*', 'hamas', 'ukrain\\w*', 'russia\\w*', 'pakistan\\w*', 'taliban', 'iran\\w*',
    'layoffs?', 'laid off', 'job cuts?', 'fired', 'sacked', 'recession', 'bankrupt\\w*', 'insolven\\w*',
    'crisis', 'plunge\\w*', 'slump\\w*', 'tumble\\w*', 'outbreak\\w*', 'virus\\w*', 'covid', 'pandemic', 'cancer',
    'curbs?', 'sanction\\w*', 'tariff\\w*', 'outage\\w*', 'delays?', 'bans?', 'banned', 'blocks?',
    // Found in a live read of the feeds: scandal and controversy, politics and law, health, mourning.
    'scandal\\w*', 'spy', 'spies', 'military', 'blacklist\\w*', 'probe\\w*', 'raid\\w*', 'scanner',
    'accus\\w*', 'cover-up', 'allegation\\w*', 'dispute\\w*', 'feud', 'takeover', 'partition',
    'court\\w*', 'police', 'cm', 'chief minister', 'minister\\w*', 'ministry', 'parliament\\w*', 'policy', 'policies',
    'security', 'concerns?', 'late', 'flu', 'illness', 'sick\\w*', 'disease\\w*', 'hospital\\w*', 'mental',
    // Market tick-by-tick and money-worry headlines are dull at best and gloomy at worst.
    'rupee', 'sensex', 'nifty', 'dollar', 'forex', 'crude', 'diesel', 'petrol', 'fuel', 'duty', 'duties',
    'inflation', 'poverty', 'bubble', 'bitcoin', 'crypto\\w*', 'downside', 'bonds', 'bond yields?', 'investors?', 'fpis?',
    'sellers?', 'stocks?',
    'live', 'watch', 'photos?', 'video', 'premium',
  ].join('|') + ')\\b',
  'i',
)

export function isCleanHeadline(title: string): boolean {
  if (title.length < MIN_CHARS || title.length > MAX_CHARS) return false
  if (title === title.toUpperCase()) return false
  if (/[|]|:\s*$/.test(title)) return false
  return !UNWANTED.test(title)
}

/** Round-robin across feeds so one publisher cannot fill the list; drops repeats. */
function interleave(perFeed: Headline[][], limit: number): Headline[] {
  const out: Headline[] = []
  const seen = new Set<string>()
  for (let i = 0; out.length < limit; i++) {
    let any = false
    for (const list of perFeed) {
      if (i >= list.length) continue
      any = true
      const key = list[i].title.toLowerCase()
      if (seen.has(key) || out.length >= limit) continue
      seen.add(key)
      out.push(list[i])
    }
    if (!any) break
  }
  return out
}

export async function fetchHeadlines(
  fetchFn: typeof fetch = fetch,
  feeds: readonly { source: string; url: string }[] = FEEDS,
): Promise<Headline[]> {
  const perFeed = await Promise.all(feeds.map(async (feed): Promise<Headline[]> => {
    try {
      const res = await fetchFn(feed.url, {
        signal: AbortSignal.timeout(5000),
        // One upstream read per feed per hour, however many people open the app.
        next: { revalidate: 3600 },
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HeadlineReader/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
      })
      if (!res.ok) return []
      const xml = (await res.text()).slice(0, 500_000)
      return parseRssTitles(xml).filter(isCleanHeadline).map(title => ({ title, source: feed.source }))
    } catch {
      // A feed that is down or slow is simply left out.
      return []
    }
  }))
  return interleave(perFeed, KEPT)
}
