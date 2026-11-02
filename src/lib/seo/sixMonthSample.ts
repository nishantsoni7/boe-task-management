import type { DiscussionBrief, SixMonthReview } from './sixMonth'

// Made-up documents for the tests. The real figures never enter the repository: it is public.

export const SAMPLE_REVIEW: SixMonthReview = {
  period: 'January to June 2030',
  verdict: { title: 'Sample verdict', text: 'Sample verdict text.', lenses: [{ label: 'Reach', tag: { text: 'Mixed', tone: 'wait' } }] },
  headline: { title: 'On last year', items: [{ label: 'Visits', note: '10 to 20', value: '+100%', tone: 'good' }] },
  causes: { title: 'Why', note: 'Not yet proven', items: [{ value: '50%', label: 'A cause', text: 'Cause text.' }] },
  good: [{ value: '+1', title: 'A good thing', tag: { text: 'SEO person', tone: 'work' }, lines: [{ text: 'Proof.' }, { label: 'Limit', text: 'A limit.' }] }],
  bad: [{ value: '-1', title: 'A bad thing', tag: { text: 'Shared', tone: 'pending' }, lines: [{ label: 'Fix', text: 'A fix.' }] }],
  moves: {
    title: 'Do these next',
    note: 'In date order',
    items: [{ tag: { text: 'You', tone: 'wait' }, title: 'First move', text: 'By 1 Jan.' }, { tag: { text: 'Claude', tone: 'work' }, title: 'Second move', text: 'By 2 Jan.' }],
    then: 'Later work.',
  },
  targets: { title: 'Targets', note: 'From the board', items: [{ value: '1 → 2', text: 'A target' }], warning: 'A warning about the target.' },
  notes: { title: 'Before you quote these numbers', items: [{ label: 'A caution.', text: 'Why it matters.' }] },
  timeline: {
    title: 'What happened',
    note: 'Month by month',
    periods: [{ label: 'First', months: 1 }, { label: 'Second', months: 1 }],
    months: ['Jan 2030', 'Feb 2030'],
    rows: [{ label: 'Visits', totals: ['1', '2'], values: [1, 2] }],
    events: [{ month: 1, text: 'An event' }],
    table: { head: ['Month', 'Visits'], rows: [['Jan 2030', '1']] },
  },
  moved: {
    title: 'What moved',
    note: 'Left is better',
    fell: { note: 'Fell', items: [{ term: 'a falling search', was: 5, now: 50 }] },
    rose: { note: 'Rose', items: [{ term: 'a rising search', was: 9, now: 3 }] },
  },
  searched: { title: 'Searches', note: 'Clicks', rows: [{ label: 'Blog', value: '10', change: '+1%', tone: 'good', share: 100 }], foot: 'A sample.' },
  ranks: { title: 'Ranks', note: 'Keywords', legend: ['Top 3', '4–10', '11–20', 'Below 20'], rows: [{ label: 'Now', parts: [1, 2, 3, 4] }], foot: 'Quick wins.' },
  spots: { title: 'Top 3', note: 'Spots', rows: [{ label: 'Us', value: 3, target: true }], foot: 'Directories.' },
  measures: { title: 'Measures', note: 'Side by side', items: [{ label: 'Clicks', value: '10', lines: [{ label: 'On last year', value: '5%', direction: 'up' }, { label: 'Earlier', value: 'No data' }], source: 'Search Console' }] },
  ai: { title: 'AI search', note: 'Checked', items: [{ title: 'Are we cited?', text: 'Sample answer.', tag: { text: 'Partial', tone: 'wait' } }] },
  gaps: { title: 'Blind spots', note: 'Free to fix', head: ['Blind spot', 'Why', 'Fix', 'Owner'], rows: [['A gap', 'Why it matters', 'The fix', 'Sales']] },
  foot: 'Sample footnote.',
}

export const SAMPLE_BRIEF: DiscussionBrief = {
  subtitle: 'Hold it soon.',
  message: 'Sample message',
  before: ['Keep to facts.'],
  credit: [{ title: 'A credit', text: 'Why.', ask: 'Ask: what next?' }],
  raise: [{ title: 'An issue', tag: { text: 'Biggest', tone: 'bad' }, text: 'The fact.', ask: 'Ask: what changed?' }],
  fair: [{ title: 'Not on them', text: 'Why.' }],
  scored: [{ title: 'A scored goal', text: 'Check: a list', value: '3' }],
  others: [{ title: 'Claude', text: 'A task.' }],
  yours: { title: 'You', text: 'Your part.' },
  next: { title: 'At the next review', rows: [{ tag: { text: 'All done', tone: 'good' }, text: 'Carry on.' }] },
  proof: {
    title: 'Proof',
    note: 'Logged entries',
    chart: 'Entries each month',
    bars: [{ month: 'Jan 2030', value: 10 }, { month: 'Feb 2030', value: 5, recent: true }],
    axis: ['Jan', 'Feb'],
    table: { head: ['Entries', 'First'], rows: [['Blogs', '3']] },
  },
  foot: 'Sample footnote.',
}
