import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SeoIngestError, parseSeoIngest } from './ingest'
import { briefProblem, sixMonthProblem } from './sixMonth'
import { SAMPLE_BRIEF, SAMPLE_CASE, SAMPLE_REPORT, SAMPLE_REVIEW } from './sixMonthSample'

const NOW = '2030-07-01T00:00:00.000Z'
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

describe('what the door accepts as a review or a brief', () => {
  test('a complete document passes', () => {
    assert.equal(sixMonthProblem(SAMPLE_REVIEW), null)
    assert.equal(briefProblem(SAMPLE_BRIEF), null)
  })

  test('optional fields may be left out', () => {
    const review = copy(SAMPLE_REVIEW)
    delete review.moves.then
    delete review.targets.warning
    delete review.headline.items[0].tone
    assert.equal(sixMonthProblem(review), null)
  })

  test('it names the first thing wrong, at any depth', () => {
    const review = copy(SAMPLE_REVIEW)
    ;(review.good[0].tag as { tone: string }).tone = 'loud'
    assert.equal(sixMonthProblem(review), 'good[0].tag must be a tag')

    const moved = copy(SAMPLE_REVIEW)
    ;(moved.moved.fell.items[0] as { was: unknown }).was = '5'
    assert.equal(sixMonthProblem(moved), 'moved.fell.items[0].was must be a number')

    const brief = copy(SAMPLE_BRIEF) as unknown as Record<string, unknown>
    delete brief.raise
    assert.equal(briefProblem(brief), 'raise must be a list')
  })

  test('a case passes without the review sections, and each section it has is checked whole', () => {
    assert.equal(briefProblem(SAMPLE_CASE), null)
    const halfClaim = copy(SAMPLE_CASE) as unknown as { claims: Record<string, unknown>[] }
    delete halfClaim.claims[0].say
    assert.equal(briefProblem(halfClaim), 'claims[0].say must be text')
    const badSection = copy(SAMPLE_CASE) as unknown as Record<string, unknown>
    badSection.talk = 'later'
    assert.equal(briefProblem(badSection), 'talk must be an object')
  })

  test('a report passes when each block is a kind the page can draw, with what that kind needs', () => {
    assert.equal(briefProblem(SAMPLE_REPORT), null)
    type Doc = { report: { blocks: Record<string, unknown>[] } } & Record<string, unknown>
    const unknownKind = copy(SAMPLE_REPORT) as unknown as Doc
    unknownKind.report.blocks[0].kind = 'poster'
    assert.equal(briefProblem(unknownKind), 'report.blocks[0].kind is not one the page can draw')
    const emptyCards = copy(SAMPLE_REPORT) as unknown as Doc
    delete emptyCards.report.blocks[0].items
    assert.equal(briefProblem(emptyCards), 'report.blocks[0] needs a title and items')
    const noTableRows = copy(SAMPLE_REPORT) as unknown as Doc
    delete noTableRows.report.blocks[2].rows
    assert.equal(briefProblem(noTableRows), 'report.blocks[2] needs a title, head and rows')
    const missingPart = copy(SAMPLE_REPORT) as unknown as Doc
    delete missingPart.proof
    assert.equal(briefProblem(missingPart), 'report.blocks[4] draws ai, which the brief does not have')
    const badProof = copy(SAMPLE_REPORT) as unknown as Doc
    ;((badProof.report.blocks[0].items as Record<string, unknown>[])[0].proofs as Record<string, unknown>[])[0].url = 'http://example.com'
    assert.equal(briefProblem(badProof), 'report.blocks[0].items[0].proofs[0].url must be an https link')
  })

  test('a short version must hold charts the page can draw, and ones that count the rankings need rankings', () => {
    type Doc = { summary: { sections: { charts: Record<string, unknown>[] }[]; source?: unknown } } & Record<string, unknown>
    const poster = copy(SAMPLE_REPORT) as unknown as Doc
    poster.summary.sections[0].charts[0].kind = 'poster'
    assert.equal(briefProblem(poster), 'summary.sections[0].charts[0].kind is not one the page can draw')
    const noItems = copy(SAMPLE_REPORT) as unknown as Doc
    noItems.summary.sections[0].charts[0].items = []
    assert.equal(briefProblem(noItems), 'summary.sections[0].charts[0] needs items')
    const noRankings = copy(SAMPLE_REPORT) as unknown as Doc
    delete noRankings.quarters
    assert.equal(briefProblem(noRankings), 'summary.sections[1].charts[0] counts the rankings, which the brief does not have')
    const noSource = copy(SAMPLE_REPORT) as unknown as Doc
    delete noSource.summary.source
    assert.equal(briefProblem(noSource), 'summary.source must be an object')
    const noSummary = copy(SAMPLE_REPORT) as unknown as Record<string, unknown>
    delete noSummary.summary
    assert.equal(briefProblem(noSummary), 'report.blocks[5] draws summary, which the brief does not have')
  })

  test('a quarter may be blank, but never text', () => {
    const brief = copy(SAMPLE_CASE) as unknown as { quarters: { rows: { values: unknown[] }[] } }
    brief.quarters.rows[0].values = [null, 4]
    assert.equal(briefProblem(brief), null)
    brief.quarters.rows[0].values = ['12']
    assert.equal(briefProblem(brief), 'quarters.rows[0].values[0] must be a number or blank')
  })

  test('a proof link must be https; a proof with no link is a named file', () => {
    type Linked = { url?: string; how?: string }
    type Doc = { findings: { proofs: Linked[] }[]; quarters: { links: string[] }; evidence: { url: string }; claims: { proofs: Linked[] }[] }
    const at = (mutate: (brief: Doc) => void) => {
      const brief = copy(SAMPLE_CASE) as unknown as Doc
      mutate(brief)
      return briefProblem(brief)
    }
    assert.equal(at(b => { delete b.findings[0].proofs[0].url }), null)
    for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', '/seo/brief', 'not a link']) {
      assert.equal(at(b => { b.findings[0].proofs[0].url = url }), 'findings[0].proofs[0].url must be an https link', url)
    }
    assert.equal(at(b => { b.quarters.links[1] = 'ftp://example.com' }), 'quarters.links[1] must be an https link')
    assert.equal(at(b => { b.evidence.url = 'http://example.com' }), 'evidence.url must be an https link')
    assert.equal(at(b => { delete b.claims[0].proofs[0].how }), 'claims[0].proofs[0].how must be text')
  })

  test('something that is not a document is refused', () => {
    assert.equal(sixMonthProblem(null), ' must be an object')
    assert.equal(briefProblem([]), ' must be an object')
  })
})

describe('the ingest door', () => {
  test('a review and a brief go to their own tables, keyed on the period', () => {
    const batches = parseSeoIngest({
      six_month_reviews: [{ period_end: '2030-06-30', body: SAMPLE_REVIEW }],
      discussion_briefs: [{ period_end: '2030-06-30', body: SAMPLE_BRIEF }],
    }, NOW)
    assert.deepEqual(batches.map(b => [b.table, b.onConflict]), [
      ['seo_six_month_reviews', 'period_end'],
      ['seo_discussion_briefs', 'period_end'],
    ])
    assert.deepEqual(batches[0].rows[0], { period_end: '2030-06-30', body: SAMPLE_REVIEW, updated_at: NOW })
  })

  test('a wrong document refuses the whole delivery', () => {
    assert.throws(() => parseSeoIngest({
      six_month_reviews: [{ period_end: '2030-06-30', body: { period: 'x' } }],
    }, NOW), (error: Error) => error instanceof SeoIngestError && error.message.startsWith('six_month_reviews[0].body'))
  })

  test('a brief sent as a review is refused, so a private page cannot land in the shared table', () => {
    assert.throws(() => parseSeoIngest({ six_month_reviews: [{ period_end: '2030-06-30', body: SAMPLE_BRIEF }] }, NOW), SeoIngestError)
  })
})

describe('who can read', () => {
  const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20270521000000_seo_six_month_review.sql'), 'utf8')
  const api = readFileSync(join(process.cwd(), 'src/lib/seo/api.ts'), 'utf8')

  test('the brief opens for the Admin only, never with the module', () => {
    const policy = migration.slice(migration.indexOf('create policy seo_discussion_briefs_read'))
    assert.match(policy.slice(0, 220), /u\.role = 'admin'/)
    assert.doesNotMatch(policy.slice(0, 220), /module_entry_open/)
  })

  test('the shared read everybody with SEO view uses never touches the brief', () => {
    const shared = api.slice(api.indexOf('export async function fetchSeoData'))
    assert.doesNotMatch(shared, /seo_discussion_briefs/)
  })

  test('no write policy exists on either table', () => {
    assert.doesNotMatch(migration, /for (insert|update|delete|all)\b/)
  })
})
