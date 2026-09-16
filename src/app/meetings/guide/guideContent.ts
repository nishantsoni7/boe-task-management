// How Meetings Work — every word the guide shows, as data.
//
// WHY THE COPY IS DATA
// --------------------
// Same reason src/app/payroll/how-it-works/guideContent.ts is: a guide that
// describes a rule the system does not apply is worse than no guide, because the
// reader who checks it finds the two disagreeing and has no way to know which is
// wrong. Keeping every sentence here lets guide.test.tsx assert the claims
// against the constants and the migration the workflow actually runs on — the
// category labels come from DISCUSSION_CATEGORY_META, the lifecycle states from
// the CHECK constraint, and the carry-forward promise from the SQL that keeps it.
//
// WHO IT IS WRITTEN FOR
// ---------------------
// A BOE employee who has never opened Meetings. So: no table names, no policy
// names, no RPC names, no "RLS", no "migration". Where a rule exists because the
// database enforces it, the sentence says what the person will SEE, not how it is
// enforced.

import {
  AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORY_HELP, DISCUSSION_CATEGORY_META,
  type AfterSalesTag, type DiscussionCategory,
} from '@/lib/meetings/discussion'

// ─── 1. The purpose map ───────────────────────────────────────────────────────

export type PurposeNode = {
  id: string
  label: string
  detail: string
}

/**
 * Meetings at the centre, its seven uses around it. On desktop these sit in a
 * compact mind map; on mobile they stack as cards in this order, which is why the
 * order is the order somebody meets them in during a week.
 */
export const PURPOSE_NODES: PurposeNode[] = [
  { id: 'agenda',   label: 'Prepare the agenda',   detail: 'Decide what has to be discussed before the meeting starts.' },
  { id: 'orders',   label: 'Review orders',        detail: 'Walk the orders and the issues raised against them, one at a time.' },
  { id: 'record',   label: 'Record the discussion', detail: 'Write down the latest position, in the meeting, while it is being said.' },
  { id: 'decide',   label: 'Take decisions',       detail: 'Record what was decided, so nobody has to remember it later.' },
  { id: 'assign',   label: 'Assign follow-up work', detail: 'Turn a decision into a task with an owner and a due date.' },
  { id: 'history',  label: 'Review older history', detail: 'See what was said about the same issue in earlier meetings.' },
  { id: 'carry',    label: 'Carry unresolved items forward', detail: 'Anything still open appears in the next meeting on its own.' },
]

// ─── 2. Before / During / After ───────────────────────────────────────────────

export type PhaseTone = 'before' | 'during' | 'after'

export type Phase = {
  id: PhaseTone
  title: string
  summary: string
  steps: string[]
}

export const PHASES: Phase[] = [
  {
    id: 'before',
    title: 'Before the meeting',
    summary: 'Ten minutes of preparation is what makes the meeting short.',
    steps: [
      'Add the discussion items — from a task with Add to Meeting, or by hand.',
      'Look through the items still open from last time. They are already on the agenda.',
      'Read what was said about them in earlier meetings.',
      'Have the order details and any evidence ready to show.',
    ],
  },
  {
    id: 'during',
    title: 'During the meeting',
    summary: 'One item at a time, and the record is written as you go — not afterwards.',
    steps: [
      'Open one item and discuss it.',
      'Record the latest position in the update box.',
      'Attach evidence — a screenshot or photo — if something needs to be shown.',
      'Record the decision that was taken.',
      'Create or link a follow-up task if somebody has to do something.',
      'Mark the item Resolved if it is finished, or leave it Open.',
    ],
  },
  {
    id: 'after',
    title: 'After the meeting',
    summary: 'Nothing has to be typed up. The meeting record is already the record.',
    steps: [
      'Complete the meeting. It becomes read-only.',
      'Follow-up work continues in Tasks, under its own owner and due date.',
      'Items still Open move to the next meeting automatically.',
      'Items marked Resolved stay in the history and stop moving forward.',
    ],
  },
]

// ─── 3. The two categories ────────────────────────────────────────────────────

export type CategoryCard = {
  category: DiscussionCategory
  label: string
  when: string
  examples: string[]
  /** Only After Sales has these. */
  tags: AfterSalesTag[]
}

export const CATEGORY_CARDS: CategoryCard[] = [
  {
    category: 'running_order',
    label: DISCUSSION_CATEGORY_META.running_order.label,
    when: DISCUSSION_CATEGORY_HELP.running_order,
    examples: [
      'Drawing approval pending',
      'Fabric approval pending',
      'Production delay',
      'Material concern',
      'QC issue',
      'Dispatch commitment',
    ],
    tags: [],
  },
  {
    category: 'after_sales',
    label: DISCUSSION_CATEGORY_META.after_sales.label,
    when: DISCUSSION_CATEGORY_HELP.after_sales,
    examples: [
      'Repair required',
      'Replacement required',
      'Site damage',
      'Wrong item delivered',
      'Finish or fitting issue',
      'Product not matching the approved requirement',
    ],
    tags: ['repair', 'replacement', 'site_issue', 'other'],
  },
]

/** The one sentence that keeps the two apart. Tested against the guide's copy. */
export const CATEGORY_DIVIDING_LINE =
  'The dividing line is dispatch. If the order has not left BOE yet it is a Running Order item; '
  + 'once it has been dispatched and something is reported, it is After Sales.'

export const AFTER_SALES_TAG_NOTE =
  `On an After Sales item you can also pick ${
    (['repair', 'replacement', 'site_issue', 'other'] as AfterSalesTag[])
      .map(tag => AFTER_SALES_TAG_LABEL[tag]).join(', ')
  } — a quick label that saves typing. It is not a separate category.`

// ─── 4. Add from a task ───────────────────────────────────────────────────────

export type CaptureStep = {
  title: string
  detail: string
}

export const CAPTURE_FLOW: CaptureStep[] = [
  { title: 'Open the task',            detail: 'The task somebody assigned you with an order update or a customer complaint.' },
  { title: 'Add to Meeting',           detail: 'A small sheet opens. Nothing else about the task changes.' },
  { title: 'Select the category',      detail: 'Running Order, or After Sales.' },
  { title: 'Confirm order and issue',  detail: 'The order number, customer and issue line are filled in where they can be read from the task. Correct anything that is wrong.' },
  { title: 'Added to the meeting agenda', detail: 'It appears on the chosen meeting straight away, and you get a link to that agenda.' },
]

export const CAPTURE_NOTES: string[] = [
  'The source task stays linked inside the Meeting discussion, so the meeting can see where the issue came from. The task itself is not changed.',
  'If there is no suitable upcoming meeting, the item waits in the Meeting Inbox and is brought into the next relevant meeting.',
  'Pressing Add to Meeting twice does not create a second item. The one already open is shown instead.',
]

// ─── 5. The lifecycle ─────────────────────────────────────────────────────────

export type LifecycleStage = {
  id: string
  label: string
  detail: string
}

export const LIFECYCLE: LifecycleStage[] = [
  { id: 'captured',  label: 'Captured',          detail: 'The issue is written down once, and keeps that identity for the rest of its life.' },
  { id: 'agenda',    label: 'Added to an agenda', detail: 'It appears on one meeting, in agenda order.' },
  { id: 'discussed', label: 'Discussed',          detail: 'The meeting records the latest position, the decision, and any evidence.' },
  { id: 'outcome',   label: 'Still Open, or Resolved', detail: 'Two outcomes, and only two. Nothing in between.' },
]

export type LifecycleBranch = {
  id: 'open' | 'resolved' | 'reopened'
  label: string
  points: string[]
}

export const LIFECYCLE_BRANCHES: LifecycleBranch[] = [
  {
    id: 'open',
    label: 'If it is still Open',
    points: [
      'It moves to the next meeting on its own — nobody has to remember it.',
      'The same discussion history continues. It is not a new, unrelated issue.',
      'Each meeting adds its own update underneath the earlier ones.',
    ],
  },
  {
    id: 'resolved',
    label: 'If it is Resolved',
    points: [
      'A short note saying how it was resolved is required.',
      'Who resolved it, and when, is recorded.',
      'The earlier meetings and their updates stay exactly as they were.',
      'It stops appearing in future meetings.',
    ],
  },
  {
    id: 'reopened',
    label: 'If it is Reopened',
    points: [
      'A reason is required, and who reopened it is recorded.',
      'The same item returns to Open — it is not a second issue.',
      'The earlier history, including the first resolution, stays unchanged.',
      'It becomes eligible for the next meeting again.',
    ],
  },
]

// ─── 6. The same issue across four meetings ───────────────────────────────────

export type TimelineMeeting = {
  meeting: string
  state: 'open' | 'resolved'
  update: string
  note: string
}

export const MULTI_MEETING_EXAMPLE: TimelineMeeting[] = [
  { meeting: 'Meeting 1', state: 'open',     update: 'Issue recorded. Action pending.',                     note: 'Somebody adds it from a task. It is discussed and left Open.' },
  { meeting: 'Meeting 2', state: 'open',     update: 'Vendor response pending.',                            note: 'Carried forward automatically. A second update is added underneath the first.' },
  { meeting: 'Meeting 3', state: 'open',     update: 'Repair approved.',                                    note: 'Carried forward again. A follow-up task is created with an owner and a due date.' },
  { meeting: 'Meeting 4', state: 'resolved', update: 'Repair completed and accepted on site. Resolved.',    note: 'Marked Resolved with a note. It does not appear in Meeting 5.' },
]

export const MULTI_MEETING_NOTE =
  'Meetings 1, 2 and 3 were all completed while this item was still open. Completing a meeting '
  + 'does not resolve anything on it — it only closes the record of that session.'

// ─── 7. Meetings versus Tasks ─────────────────────────────────────────────────

export type ComparisonSide = {
  id: 'meetings' | 'tasks'
  label: string
  answers: string[]
}

export const MEETINGS_VS_TASKS: ComparisonSide[] = [
  {
    id: 'meetings',
    label: 'Meetings answer',
    answers: [
      'What needs discussion',
      'What was decided',
      'What evidence was reviewed',
      'What remains open for the next meeting',
    ],
  },
  {
    id: 'tasks',
    label: 'Tasks answer',
    answers: [
      'Who must do the work',
      'By when it is due',
      'Where the execution has got to',
      'Whether it is completed, and by whom',
    ],
  },
]

export const MEETINGS_VS_TASKS_RULE = [
  'Completing a meeting does not complete its linked tasks.',
  'Completing a task does not resolve the meeting discussion. Somebody with permission has to resolve it.',
]

// ─── 8. The checklist ─────────────────────────────────────────────────────────

export const COMPLETION_CHECKLIST: string[] = [
  'Every item you discussed has an update recorded against it',
  'The decisions taken are written down',
  'Any evidence that was shown is attached',
  'Follow-up tasks have an owner and a due date',
  'Finished issues are marked Resolved, with a note',
  'Unfinished issues are left Open, so they move forward',
]

// ─── 9. Questions ─────────────────────────────────────────────────────────────

export type Faq = { question: string; answer: string }

export const FAQS: Faq[] = [
  {
    question: 'What happens if an issue is not finished in one meeting?',
    answer:
      'Leave it Open. When the next meeting of the same kind is created, it is added to that '
      + 'agenda automatically, with its whole history intact and nothing rewritten.',
  },
  {
    question: 'Can the same order have more than one issue?',
    answer:
      'Yes, as many as it really has. Two Running Order concerns and an After Sales repair on the '
      + 'same order are three separate items with three separate histories, all showing the same '
      + 'order number.',
  },
  {
    question: 'What is the difference between completing a meeting and resolving an issue?',
    answer:
      'Completing a meeting closes the record of that session and makes it read-only. Resolving an '
      + 'issue says the business problem is finished. An issue can stay open across several '
      + 'completed meetings.',
  },
  {
    question: 'Where should I assign responsibility?',
    answer:
      'In Tasks. Create the follow-up task from the discussion and give it an owner and a due date '
      + 'there. Meetings records what was discussed and decided; it does not track who is doing it.',
  },
  {
    question: 'Can I see what was discussed in earlier meetings?',
    answer:
      'Yes. Open the item and the earlier meetings are listed underneath, newest first, grouped by '
      + 'meeting, read-only. The order’s general history — every other matter raised against the '
      + 'same order number — is shown separately on the order.',
  },
  {
    question: 'What happens when an issue is reopened?',
    answer:
      'It returns to Open with the reason recorded, and becomes eligible for the next meeting. '
      + 'Nothing in the earlier meetings changes, and the original resolution note stays visible in '
      + 'the history.',
  },
  {
    question: 'What if no upcoming meeting has been created?',
    answer:
      'The item waits in the Meeting Inbox and is shown as waiting for a meeting. Somebody who can '
      + 'edit a meeting can attach it, and when the next relevant meeting is created it is brought '
      + 'in once.',
  },
  {
    question: 'Can a viewer edit meeting information?',
    answer:
      'No. If you can read a meeting but not conduct it, the update box, the evidence upload and the '
      + 'Resolve and Reopen actions are not offered — and would be refused if they were. A completed '
      + 'meeting is read-only for everyone until it is reopened.',
  },
]

// ─── The section index, for the jump links and the outline ────────────────────

export type GuideSection = { id: string; title: string }

export const SECTIONS: GuideSection[] = [
  { id: 'purpose',    title: 'What Meetings is for' },
  { id: 'phases',     title: 'Before, during and after' },
  { id: 'categories', title: 'The two order categories' },
  { id: 'capture',    title: 'Adding an issue from a task' },
  { id: 'lifecycle',  title: 'The life of an issue' },
  { id: 'example',    title: 'The same issue across four meetings' },
  { id: 'vs-tasks',   title: 'Meetings and Tasks' },
  { id: 'checklist',  title: 'Before you complete a meeting' },
  { id: 'faq',        title: 'Questions' },
]
