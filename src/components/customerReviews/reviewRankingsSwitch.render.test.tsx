/**
 * THE REVIEW RANKING SWITCH, ACTUALLY RENDERED.
 *
 * `rankingsSwitch.test.ts` pins the source text; this renders the screens. What is proved:
 * the Reviews landing panel draws NOTHING unless the switch has been read as on (off, still
 * loading and unreadable all draw nothing), draws the board with its "How is this ranked?"
 * note when on, and the Control Center switch says what the state is and refuses to offer a
 * change it could not read. The database half (only an administrator can flip it, no client
 * can write the table) is the PGlite rehearsal named in the migration's pull request.
 *
 * Run: npm run test:file -- src/components/customerReviews/reviewRankingsSwitch.render.test.tsx
 */

import { before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { REVIEW_RANKINGS_KEY } from '@/lib/customerReviews/rankingsSwitch'
import { REVIEW_LEADERBOARD_KEY, type Leaderboard } from '@/lib/customerReviews/reviewReport'
import type { RankingsRead } from '@/hooks/queries/useReviewRankings'
import type { ReviewsLeaderboardPanel as Panel } from './ReviewsLeaderboardPanel'
import type { ReviewRankingsSetting as Setting } from '@/components/controlCenter/ReviewRankingsSetting'

// createClient() runs when the panel renders; it only needs a URL and a key to exist.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'

let ReviewsLeaderboardPanel: typeof Panel
let ReviewRankingsSetting: typeof Setting

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  ReviewsLeaderboardPanel = (await import('./ReviewsLeaderboardPanel')).ReviewsLeaderboardPanel
  ReviewRankingsSetting = (await import('@/components/controlCenter/ReviewRankingsSetting')).ReviewRankingsSetting
})

const BOARD: Leaderboard = {
  month: '2026-11-01', current_month: '2026-11-01', leader_reviews: 6, leaders: 1, state: 'behind', need: 2,
  me: { rank: 2, reviews: 5, credits: 50, points: 5 }, participants: 3,
  rows: [
    { rank: 1, employee_id: 'e1', name: 'Asha Verma', reviews: 6, credits: 60, points: 6, is_me: false, tied: false },
    { rank: 2, employee_id: 'e2', name: 'Rohan Mehta', reviews: 5, credits: 50, points: 5, is_me: true, tied: false },
    { rank: 3, employee_id: 'e3', name: 'Isha Rao', reviews: 2, credits: 20, points: 2, is_me: false, tied: false },
  ],
}

function render(node: React.ReactNode, switchRead: RankingsRead | null, withBoard = true): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (switchRead) client.setQueryData(REVIEW_RANKINGS_KEY, switchRead)
  if (withBoard) client.setQueryData([...REVIEW_LEADERBOARD_KEY, null], BOARD)
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('the Reviews landing panel', () => {
  test('draws nothing while the switch is off, even with the board already cached', () => {
    assert.equal(render(<ReviewsLeaderboardPanel />, { visible: false, failed: false }), '')
  })

  test('draws nothing before the switch has been read, and when it could not be read', () => {
    assert.equal(render(<ReviewsLeaderboardPanel />, null), '')
    assert.equal(render(<ReviewsLeaderboardPanel />, { visible: false, failed: true }), '')
  })

  test('draws the board when the switch is on: the leader, the ranking, the explanation', () => {
    const html = render(<ReviewsLeaderboardPanel />, { visible: true, failed: false })
    assert.match(html, /Leaderboard/)
    assert.match(html, /November 2026/)
    assert.match(html, /Asha Verma/)
    assert.match(html, /aria-label="Ranking"/)
    assert.match(html, /How is this ranked\?/)
    assert.match(html, /Equal counts share a rank/)
    // The phone keeps its one compact line.
    assert.match(html, /class="crv-lb-compact"/)
  })

  test('your own row is marked, and each row carries a bar against the leader', () => {
    const html = render(<ReviewsLeaderboardPanel />, { visible: true, failed: false })
    assert.match(html, /Rohan Mehta \(you\)/)
    assert.match(html, /aria-current="true"/)
    assert.match(html, /width:100%/) // the leader
    assert.match(html, /width:83%/) // 5 of 6
    assert.match(html, /width:33%/) // 2 of 6
  })
})

describe('the Control Center switch', () => {
  test('says Hidden and offers to show it, when off', () => {
    const html = render(<ReviewRankingsSetting />, { visible: false, failed: false }, false)
    assert.match(html, /Hidden/)
    assert.match(html, /Show the ranking/)
    assert.doesNotMatch(html, /Hide the ranking/)
  })

  test('says Shown and offers to hide it, when on', () => {
    const html = render(<ReviewRankingsSetting />, { visible: true, failed: false }, false)
    assert.match(html, /Shown/)
    assert.match(html, /Hide the ranking/)
  })

  test('refuses to offer a change when the setting could not be read, and says why', () => {
    const html = render(<ReviewRankingsSetting />, { visible: false, failed: true }, false)
    assert.match(html, /could not be read/)
    assert.match(html, /<button[^>]*disabled/)
  })
})
