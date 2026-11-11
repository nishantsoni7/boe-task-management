// The rolling 6-month review and the private discussion brief. Each is one document a period, written by the scheduled
// sessions in the website folder and sent through the ingest door. The figures live in the database, never here: the
// repository is public. The specs below are what the door accepts, so a screen can trust every field it draws.

export type SeoTone = 'good' | 'bad' | 'wait' | 'work' | 'pending'
export type SeoTag = { text: string; tone: SeoTone }

type Line = { label?: string; text: string }
export type SeoFinding = { value: string; title: string; tag: SeoTag; lines: Line[] }
export type SeoMover = { term: string; was: number; now: number }
type Titled = { title: string; note: string }

export type SixMonthReview = {
  period: string
  verdict: { title: string; text: string; lenses: { label: string; tag: SeoTag }[] }
  headline: { title: string; items: { label: string; note: string; value: string; tone?: SeoTone }[] }
  causes: Titled & { items: { value: string; tone?: SeoTone; label: string; text: string }[] }
  good: SeoFinding[]
  bad: SeoFinding[]
  moves: Titled & { items: { tag: SeoTag; title: string; text: string }[]; then?: string }
  targets: Titled & { items: { value: string; text: string }[]; warning?: string }
  notes: { title: string; items: { label: string; text: string }[] }
  timeline: Titled & {
    periods: { label: string; months: number }[]
    months: string[]
    rows: { label: string; totals: string[]; values: number[] }[]
    events: { month: number; text: string }[]
    table: { head: string[]; rows: string[][] }
  }
  moved: Titled & { fell: { note: string; items: SeoMover[] }; rose: { note: string; items: SeoMover[] } }
  searched: Titled & { rows: { label: string; value: string; change: string; tone?: SeoTone; target?: boolean; share: number }[]; foot: string }
  ranks: Titled & { legend: string[]; rows: { label: string; parts: number[] }[]; foot: string }
  spots: Titled & { rows: { label: string; value: number; target?: boolean }[]; foot: string }
  measures: Titled & { items: { label: string; value: string; lines: { label: string; value: string; direction?: 'up' | 'down' }[]; source: string }[] }
  ai: Titled & { items: { title: string; text: string; tag: SeoTag }[] }
  gaps: Titled & { head: string[]; rows: string[][] }
  foot: string
}

export type DiscussionBrief = {
  subtitle: string
  message: string
  before: string[]
  credit: { title: string; text: string; ask?: string }[]
  raise: { title: string; tag: SeoTag; text: string; ask: string }[]
  fair: { title: string; text: string }[]
  scored?: { title: string; text: string; value: string }[]
  others?: { title: string; text: string }[]
  yours?: { title: string; text: string }
  next?: { title: string; rows: { tag: SeoTag; text: string }[] }
  proof: Titled & {
    chart: string
    bars: { month: string; value: number; recent?: boolean }[]
    axis: string[]
    table: { head: string[]; rows: string[][] }
  }
  foot: string
} & Partial<BriefCase>

/** The case for a decision about the role (November 2026). A brief with `claims` is drawn as a case; one without, as a review. */
export type BriefCase = {
  headline: { title: string; items: { label: string; note: string; value: string; tone?: SeoTone }[] }
  trend: Titled & { months: string[]; series: { label: string; values: number[] }[]; events: { month: number; text: string }[]; takeaway: string }
  quarters: Titled & {
    columns: string[]
    rows: { keyword: string; demand: string; values: (number | null)[] }[]
    totals: { label: string; values: string[] }[]
    caveat: string
    takeaway: string
  }
  leads: { title: string; steps: { label: string; value: string; note: string; tone?: SeoTone }[]; head: string[]; rows: string[][]; takeaway: string }
  base: Titled & { head: string[]; rows: string[][]; takeaway: string }
  risers: Titled & { rows: { site: string; from: string; to: string; text: string }[]; fair: string }
  claims: { claim: string; tag: SeoTag; data: string[]; research: string[]; say: string }[]
  counters: { says: string; answer: string }[]
  missed: { title: string; text: string; tag: SeoTag }[]
  plan: Titled & { rows: { task: string; who: string; when: string }[]; risks: string[] }
  talk: Titled & { steps: { title: string; text: string; say?: string }[]; avoid: string[]; care: string[] }
  sources: string[]
}

export type SixMonthRow = { period_end: string; body: SixMonthReview }
export type DiscussionBriefRow = { period_end: string; body: DiscussionBrief }

type Spec = 'text' | 'text?' | 'number' | 'number?' | 'tag' | 'tone?' | 'bool?' | 'direction?' | readonly [Spec] | { readonly [key: string]: Spec }

// A whole section that may be left out. An object with the single key '?' is never a real section.
const optional = <S extends Spec>(spec: S) => ({ '?': spec }) as const

const TITLED = { title: 'text', note: 'text' } as const
const FINDING = { value: 'text', title: 'text', tag: 'tag', lines: [{ label: 'text?', text: 'text' }] } as const
const MOVER = { term: 'text', was: 'number', now: 'number' } as const
const TABLE = { head: ['text'], rows: [['text']] } as const

const REVIEW_SPEC = {
  period: 'text',
  verdict: { title: 'text', text: 'text', lenses: [{ label: 'text', tag: 'tag' }] },
  headline: { title: 'text', items: [{ label: 'text', note: 'text', value: 'text', tone: 'tone?' }] },
  causes: { ...TITLED, items: [{ value: 'text', tone: 'tone?', label: 'text', text: 'text' }] },
  good: [FINDING],
  bad: [FINDING],
  moves: { ...TITLED, items: [{ tag: 'tag', title: 'text', text: 'text' }], then: 'text?' },
  targets: { ...TITLED, items: [{ value: 'text', text: 'text' }], warning: 'text?' },
  notes: { title: 'text', items: [{ label: 'text', text: 'text' }] },
  timeline: {
    ...TITLED,
    periods: [{ label: 'text', months: 'number' }],
    months: ['text'],
    rows: [{ label: 'text', totals: ['text'], values: ['number'] }],
    events: [{ month: 'number', text: 'text' }],
    table: TABLE,
  },
  moved: { ...TITLED, fell: { note: 'text', items: [MOVER] }, rose: { note: 'text', items: [MOVER] } },
  searched: { ...TITLED, rows: [{ label: 'text', value: 'text', change: 'text', tone: 'tone?', target: 'bool?', share: 'number' }], foot: 'text' },
  ranks: { ...TITLED, legend: ['text'], rows: [{ label: 'text', parts: ['number'] }], foot: 'text' },
  spots: { ...TITLED, rows: [{ label: 'text', value: 'number', target: 'bool?' }], foot: 'text' },
  measures: {
    ...TITLED,
    items: [{ label: 'text', value: 'text', lines: [{ label: 'text', value: 'text', direction: 'direction?' }], source: 'text' }],
  },
  ai: { ...TITLED, items: [{ title: 'text', text: 'text', tag: 'tag' }] },
  gaps: { ...TITLED, ...TABLE },
  foot: 'text',
} satisfies Spec

const BRIEF_SPEC = {
  subtitle: 'text',
  message: 'text',
  before: ['text'],
  credit: [{ title: 'text', text: 'text', ask: 'text?' }],
  raise: [{ title: 'text', tag: 'tag', text: 'text', ask: 'text' }],
  fair: [{ title: 'text', text: 'text' }],
  scored: optional([{ title: 'text', text: 'text', value: 'text' }]),
  others: optional([{ title: 'text', text: 'text' }]),
  yours: optional({ title: 'text', text: 'text' }),
  next: optional({ title: 'text', rows: [{ tag: 'tag', text: 'text' }] }),
  proof: { ...TITLED, chart: 'text', bars: [{ month: 'text', value: 'number', recent: 'bool?' }], axis: ['text'], table: TABLE },
  foot: 'text',
  headline: optional({ title: 'text', items: [{ label: 'text', note: 'text', value: 'text', tone: 'tone?' }] }),
  trend: optional({ ...TITLED, months: ['text'], series: [{ label: 'text', values: ['number'] }], events: [{ month: 'number', text: 'text' }], takeaway: 'text' }),
  quarters: optional({
    ...TITLED,
    columns: ['text'],
    rows: [{ keyword: 'text', demand: 'text', values: ['number?'] }],
    totals: [{ label: 'text', values: ['text'] }],
    caveat: 'text',
    takeaway: 'text',
  }),
  leads: optional({ title: 'text', steps: [{ label: 'text', value: 'text', note: 'text', tone: 'tone?' }], ...TABLE, takeaway: 'text' }),
  base: optional({ ...TITLED, ...TABLE, takeaway: 'text' }),
  risers: optional({ ...TITLED, rows: [{ site: 'text', from: 'text', to: 'text', text: 'text' }], fair: 'text' }),
  claims: optional([{ claim: 'text', tag: 'tag', data: ['text'], research: ['text'], say: 'text' }]),
  counters: optional([{ says: 'text', answer: 'text' }]),
  missed: optional([{ title: 'text', text: 'text', tag: 'tag' }]),
  plan: optional({ ...TITLED, rows: [{ task: 'text', who: 'text', when: 'text' }], risks: ['text'] }),
  talk: optional({ ...TITLED, steps: [{ title: 'text', text: 'text', say: 'text?' }], avoid: ['text'], care: ['text'] }),
  sources: optional(['text']),
} satisfies Spec

const TONES: readonly unknown[] = ['good', 'bad', 'wait', 'work', 'pending']
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first thing wrong with a document, or null. */
function problem(value: unknown, spec: Spec, where: string): string | null {
  if (isObject(spec) && '?' in spec) return value === undefined ? null : problem(value, spec['?'] as Spec, where)
  const mayBeMissing = spec === 'text?' || spec === 'number?' || spec === 'tone?' || spec === 'bool?' || spec === 'direction?'
  if (mayBeMissing && value === undefined) return null
  if (spec === 'text' || spec === 'text?') return typeof value === 'string' ? null : `${where} must be text`
  if (spec === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${where} must be a number`
  // A blank cell, such as a quarter with no reading.
  if (spec === 'number?') return value === null || (typeof value === 'number' && Number.isFinite(value)) ? null : `${where} must be a number or blank`
  if (spec === 'bool?') return typeof value === 'boolean' ? null : `${where} must be true or false`
  if (spec === 'tone?') return TONES.includes(value) ? null : `${where} is not a tone`
  if (spec === 'direction?') return value === 'up' || value === 'down' ? null : `${where} must be up or down`
  if (spec === 'tag') return isObject(value) && typeof value.text === 'string' && TONES.includes(value.tone) ? null : `${where} must be a tag`
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) return `${where} must be a list`
    for (const [index, item] of value.entries()) {
      const found = problem(item, (spec as readonly [Spec])[0], `${where}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!isObject(value)) return `${where} must be an object`
  for (const [key, inner] of Object.entries(spec as Record<string, Spec>)) {
    const found = problem(value[key], inner, where ? `${where}.${key}` : key)
    if (found) return found
  }
  return null
}

export const sixMonthProblem = (body: unknown) => problem(body, REVIEW_SPEC, '')
export const briefProblem = (body: unknown) => problem(body, BRIEF_SPEC, '')
