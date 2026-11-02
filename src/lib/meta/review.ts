// The Monday review: load, work out the figures, ask Claude for the words, check them, save. A failed run keeps its
// own row and leaves every earlier review alone. Nothing here reaches Meta; the sync has already read it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { istAddDays, istDateOf, istMonthStartOffset, istToday } from '@/lib/istDate'
import { fetchMetaInsights, fetchMetaStructure, type MetaStructure } from './api'
import type { MetaInsight } from './report'
import { parseReviewAnswer, REVIEW_SYSTEM_PROMPT, REVIEW_TOOL, reviewPrompt, type ReviewAnswer } from './reviewAnswer'
import { lessonStrength, reviewedWeek, ruleNeeds, weeklyFacts, type NeedDraft, type WeeklyFacts } from './weekly'

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5']
const PROVIDER_TIMEOUT_MS = 120_000
const MAX_TOKENS = 6000
const TRIES = 2
const SYNC_TOO_OLD_DAYS = 3
const HISTORY_MONTHS = 13
const RULE_KEYS = ['set_target', 'set_cap', 'silent_campaigns', 'confirm_learnings']

export type LearningRow = { lesson_key: string; title: string; status: string }
export type NeedRow = { need_key: string; status: string }
export type Loaded = {
  structure: MetaStructure; insights: MetaInsight[]; learnings: LearningRow[]; needs: NeedRow[]
  /** This week's existing row, if a run already wrote one. */
  reviewStatus: string | null
}

export type ReviewStore = {
  load(today: string, weekStart: string): Promise<Loaded>
  saveReview(row: object): Promise<void>
  saveLearnings(rows: object[]): Promise<void>
  saveNeeds(rows: object[]): Promise<void>
}

export type Ask = (system: string, prompt: string) => Promise<{ input: unknown; model: string }>
export type ReviewResult = { status: 'ok' | 'done' | 'failed'; message: string }

/** New lessons are added and open ones refreshed. One a person already decided is left exactly as it is. */
export function planLearnings(answer: ReviewAnswer, known: LearningRow[], facts: WeeklyFacts, stamp: string) {
  const decided = new Set(known.filter(l => l.status !== 'open').map(l => l.lesson_key))
  return answer.learnings.filter(l => !decided.has(l.key)).map(l => ({
    lesson_key: l.key, title: l.title, evidence: l.evidence, strength: lessonStrength(l.refs, facts), first_seen_week: facts.week.from, updated_at: stamp,
  }))
}

/**
 * A rule's need closes by itself when the rule stops applying and reopens when it applies again. A need somebody
 * dismissed stays dismissed, and a Look at need is never reopened: next week's review may raise it under a new reason.
 */
export function planNeeds(drafts: NeedDraft[], known: NeedRow[], stamp: string) {
  const status = new Map(known.map(n => [n.need_key, n.status]))
  const wanted = new Set(drafts.map(d => d.need_key))
  const rows: object[] = []
  for (const draft of drafts) {
    const current = status.get(draft.need_key)
    if (current === 'dismissed' || (current === 'done' && !RULE_KEYS.includes(draft.need_key))) continue
    rows.push({ ...draft, status: 'open', resolved_at: null, updated_at: stamp })
  }
  for (const key of RULE_KEYS) {
    if (status.get(key) === 'open' && !wanted.has(key)) rows.push({ need_key: key, status: 'done', resolved_at: stamp, updated_at: stamp })
  }
  return rows
}

const lookNeeds = (answer: ReviewAnswer): NeedDraft[] => answer.lookAt
  .map((item): NeedDraft => ({ need_key: `look:${item.refs[0]}`, title: `Decide on ${item.title}`.slice(0, 200), why: item.why, next_step: 'task' }))
  .filter((need, index, all) => all.findIndex(n => n.need_key === need.need_key) === index)

async function askChecked(ask: Ask, facts: WeeklyFacts, known: LearningRow[]) {
  const base = reviewPrompt(facts, known.map(l => ({ key: l.lesson_key, title: l.title, status: l.status })))
  let prompt = base
  let reason = ''
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const { input, model } = await ask(REVIEW_SYSTEM_PROMPT, prompt)
    try {
      return { answer: parseReviewAnswer(input, facts), model }
    } catch (error) {
      reason = error instanceof Error ? error.message : 'the answer could not be read'
      prompt = `${base}\n\nYour last answer was refused: ${reason}. Answer again.`
    }
  }
  throw new Error(`The answer failed its check: ${reason}`)
}

const EMPTY: ReviewAnswer = { headline: 'Too little to judge', summary: '', keep: [], lookAt: [], tryNext: [], learnings: [] }

export async function runMetaReview({ store, ask, now = new Date() }: { store: ReviewStore; ask: Ask; now?: Date }): Promise<ReviewResult> {
  const today = istToday(now)
  const stamp = now.toISOString()
  const week = reviewedWeek(today)
  const data = await store.load(today, week.start)
  if (data.reviewStatus === 'ok') return { status: 'done', message: 'This week is already reviewed.' }

  try {
    const lastOk = data.structure.runs.find(r => r.status === 'ok')?.finished_at
    if (!lastOk || istDateOf(lastOk) < istAddDays(today, -SYNC_TOO_OLD_DAYS)) throw new Error('The daily read is out of date, so the figures cannot be trusted.')

    const { campaigns, adSets, settings } = data.structure
    const facts = weeklyFacts({ campaigns, adSets, insights: data.insights, settings, today })
    const { answer, model } = facts.verdict === 'quiet' ? { answer: EMPTY, model: '' } : await askChecked(ask, facts, data.learnings)

    const { history: _history, ...numbers } = facts
    const { learnings, ...body } = answer
    await store.saveReview({ week_start: week.start, week_end: week.end, status: 'ok', verdict: facts.verdict, numbers, body, message: '', model, created_at: stamp })

    const lessons = planLearnings(answer, data.learnings, facts, stamp)
    if (lessons.length > 0) await store.saveLearnings(lessons)
    const added = lessons.filter(l => !data.learnings.some(k => k.lesson_key === l.lesson_key)).length
    const open = data.learnings.filter(l => l.status === 'open').length + added
    const needs = planNeeds([...ruleNeeds(facts, settings, open), ...lookNeeds(answer)], data.needs, stamp)
    if (needs.length > 0) await store.saveNeeds(needs)
    return { status: 'ok', message: learnings.length === 0 ? '' : `${learnings.length} learnings proposed` }
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'The review failed.').slice(0, 500)
    await store.saveReview({ week_start: week.start, week_end: week.end, status: 'failed', verdict: null, numbers: {}, body: {}, message, model: '', created_at: stamp })
    return { status: 'failed', message }
  }
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`Saving ${what} failed: ${error.message}`.slice(0, 300))
}

export function supabaseReviewStore(svc: SupabaseClient): ReviewStore {
  return {
    async load(today, weekStart) {
      const [structure, insights, learnings, needs, review] = await Promise.all([
        fetchMetaStructure(svc, today),
        fetchMetaInsights(svc, istMonthStartOffset(today, HISTORY_MONTHS), today),
        svc.from('meta_learnings').select('lesson_key, title, status'),
        svc.from('meta_needs').select('need_key, status'),
        svc.from('meta_reviews').select('status').eq('week_start', weekStart).maybeSingle(),
      ])
      for (const result of [learnings, needs, review]) if (result.error) throw new Error(result.error.message)
      return {
        structure, insights,
        learnings: (learnings.data ?? []) as LearningRow[], needs: (needs.data ?? []) as NeedRow[],
        reviewStatus: (review.data as { status: string } | null)?.status ?? null,
      }
    },
    async saveReview(row) {
      check((await svc.from('meta_reviews').upsert(row, { onConflict: 'week_start' })).error, 'the review')
    },
    async saveLearnings(rows) {
      check((await svc.from('meta_learnings').upsert(rows, { onConflict: 'lesson_key' })).error, 'the learnings')
    },
    async saveNeeds(rows) {
      for (const row of rows) check((await svc.from('meta_needs').upsert(row, { onConflict: 'need_key' })).error, 'the needs')
    },
  }
}

type Answer = { content?: { type: string; input?: unknown }[] }

export function anthropicAsk(apiKey: string, doFetch: typeof fetch = fetch): Ask {
  return async (system, prompt) => {
    for (const model of MODELS) {
      const res = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: MAX_TOKENS, system, tools: [REVIEW_TOOL],
          tool_choice: { type: 'tool', name: REVIEW_TOOL.name },
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (res.ok) {
        const answer = await res.json() as Answer
        const input = answer.content?.find(block => block.type === 'tool_use')?.input
        if (input === undefined) throw new Error('Claude answered without a review.')
        return { input, model }
      }
      // Only a model this account does not have moves on to the next; a bad key or a busy service would fail them all.
      if (res.status !== 404) throw new Error(`Claude refused the request (${res.status}).`)
    }
    throw new Error('No Claude model was available.')
  }
}
