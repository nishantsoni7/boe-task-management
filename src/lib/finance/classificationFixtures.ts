// ── The classification fixtures ───────────────────────────────────────────────
//
// ONE DEFINITION OF THE WORKED EXAMPLES for the payment classification, consumed
// by both sides of the parity check:
//
//   TypeScript  paymentClassification.test.ts runs classifyPayment over these
//   SQL         supabase/tests/payment_classification_assertions.sql inserts the
//               same rows and asserts the same figures out of
//               finance_received_payments
//
// They exist as DATA rather than as prose repeated in two files, for the same
// reason ./attributionFixtures.ts does: two implementations of one financial
// rule tested against subtly different scenarios is how the defect PR #49 fixed
// survived for months.
//
// THE FIRST EIGHT ARE THE ATTRIBUTION FIXTURES, NOT COPIES OF THEM. A–H are
// imported from ./attributionFixtures and split by target KIND here, so the
// classification can never be tested against a scenario the attribution rule
// does not also answer. What this file adds is the cases the classification
// raises that the attribution rule alone does not: a PI-only payment, a mixed
// Order/PI split, money with nothing pointing at it, the two non-verified
// states, and a figure in paise.
//
// Amounts are strings, because that is how `numeric` crosses the wire and
// nothing here may pass through a float on its way to a decision.

import { ATTRIBUTION_FIXTURES, type FixtureAllocation } from './attributionFixtures'

// ── Tiny exact helpers, used only to express the fixtures ─────────────────────
//
// Deliberately NOT ./exactMoney: these build the EXPECTED values, and expressing
// an expectation with the implementation under test is how a test comes to
// assert that a function agrees with itself. Both operate on two-decimal rupee
// strings, which is all a fixture ever carries.

// The constructor form, not `0n`: this project's tsconfig targets below ES2020,
// where BigInt LITERALS are a syntax error. exactMoney.ts does the same.
const BIG_ZERO = BigInt(0)
const BIG_ONE = BigInt(1)
const BIG_HUNDRED = BigInt(100)

function sumStrings(values: readonly string[]): string {
  if (values.length === 0) return '0'
  let paise = BIG_ZERO
  for (const value of values) paise += toPaise(value)
  return fromPaise(paise)
}

function toPaise(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  const padded = (fraction + '00').slice(0, 2)
  const sign = whole.startsWith('-') ? -BIG_ONE : BIG_ONE
  return sign * (BigInt(whole.replace('-', '')) * BIG_HUNDRED + BigInt(padded))
}

function fromPaise(paise: bigint): string {
  const negative = paise < BIG_ZERO
  const abs = negative ? -paise : paise
  const whole = abs / BIG_HUNDRED
  const fraction = (abs % BIG_HUNDRED).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

function isZeroString(value: string | null): boolean {
  if (value === null) return true
  return toPaise(value) === BIG_ZERO
}

export type ClassificationFixture = {
  /** The letter, for the reader of a failing assertion. */
  label: string
  paymentId: string
  amount: string
  /** The ledger status. Decides the verification axis, and whether it counts. */
  status: 'approved_unlinked' | 'approved_linked' | 'pending_approval' | 'rejected'
  /** The Order the payment's own order_id names, or null. */
  directLinkTarget: string | null
  allocations: FixtureAllocation[]
  /** Whether the reader's sight of the allocation table is complete. */
  attributionComplete: boolean
  expected: {
    orderLinked: string
    piLinked: string
    /** Null when it may not be stated — see paymentClassification.ts. */
    available: string | null
    allocationCount: number
    verification: 'verified' | 'awaiting' | 'rejected'
    overAllocated: boolean
    /** Every view this payment must appear in. Order-insensitive. */
    views: string[]
  }
  note: string
}

// The targets the added fixtures (I onwards) name. A–H bring their own from
// ./attributionFixtures, which is where Order Y lives — the second Order exists
// only in the split cases those fixtures already cover.
const X = 'ORDER_X'
const PI = 'SUBMISSION_P'
const PI2 = 'SUBMISSION_Q'

/** The active allocations of a fixture that name an Order / a PI. */
function splitByKind(allocations: readonly FixtureAllocation[]) {
  const active = allocations.filter(a => a.status === 'active')
  return {
    orders: active.filter(a => a.targetKind === 'order'),
    submissions: active.filter(a => a.targetKind === 'submission'),
    count: active.length,
  }
}

/**
 * One of the attribution fixtures, re-expressed as a classification fixture.
 *
 * THE FIGURES ARE THE ATTRIBUTION FIXTURE'S OWN, summed by kind — not recomputed
 * from the allocations by a second rule. `expectedUnallocated` and
 * `expectedState` come straight across, so a change to the canonical worked
 * examples cannot leave this file asserting the old ones.
 */
function fromAttribution(key: keyof typeof ATTRIBUTION_FIXTURES, note: string): ClassificationFixture {
  const f = ATTRIBUTION_FIXTURES[key]
  const { orders, submissions, count } = splitByKind(f.allocations)

  // ACTIVE ALLOCATION ROWS, SUMMED BY KIND, AND NOTHING ELSE. This used to fall
  // back to the whole amount when a payment had no active allocation but did
  // carry a direct link. That fallback is gone from the rule, so it is gone
  // from the fixtures that describe the rule.
  const orderLinked = sumStrings(orders.map(a => a.amount))
  const piLinked = sumStrings(submissions.map(a => a.amount))

  const views = ['all']
  if (!isZeroString(orderLinked)) views.push('orders')
  if (!isZeroString(piLinked)) views.push('pi_drafts')
  if (!isZeroString(f.expectedUnallocated)) views.push('available')

  return {
    label: f.label,
    paymentId: f.paymentId,
    amount: f.amount,
    status: 'approved_unlinked',
    directLinkTarget: f.directLinkTarget,
    allocations: f.allocations,
    attributionComplete: true,
    expected: {
      orderLinked,
      piLinked,
      available: f.expectedUnallocated,
      allocationCount: count,
      verification: 'verified',
      overAllocated: f.expectedState === 'over',
      views,
    },
    note,
  }
}

export const CLASSIFICATION_FIXTURES: Record<string, ClassificationFixture> = {
  // ── A–H: the canonical attribution examples, split by target kind ──
  A: fromAttribution('A',
    'A dormant order_id and no active allocation: attributed to NOBODY, so it '
    + 'is not Order-linked and its whole amount is available to allocate. It '
    + 'used to read fully Order-linked through the direct-link fallback.'),
  B: fromAttribution('B',
    'Partially allocated with an available balance. Appears in Orders AND in '
    + 'Available at the same time — the two views are not a partition.'),
  C: fromAttribution('C',
    'The Order the dormant link names is attributed nothing — no allocation '
    + 'names it — and only Y appears under Orders.'),
  D: fromAttribution('D',
    'Split across two Orders, summing to the payment. Orders only; nothing left '
    + 'to allocate.'),
  E: fromAttribution('E',
    'A reversed allocation counts for nothing, which leaves no active row at '
    + 'all — so this behaves exactly as A: attributed to nobody, wholly '
    + 'available. The reversed row must not appear in the allocation count.'),
  F: fromAttribution('F',
    'Historical over-allocation. It stays visible as an error state, is never '
    + 'silently capped, and reports no available balance.'),
  G_pi: fromAttribution('G_pi',
    'A dormant Order link and an active allocation to a PI. Only the allocation '
    + 'attributes, so this is a PI-linked payment with a balance — it must NOT '
    + 'appear under Orders.'),
  H_replaced: fromAttribution('H_replaced',
    'A corrected allocation: the reversed row stays in the trail and only the '
    + 'active replacement counts.'),

  // ── I–N: what the classification adds ──

  /** Fully PI-linked. No Order anywhere on the row. */
  I_pi_only: {
    label: 'I',
    paymentId: '11111111-0000-0000-0000-000000000011',
    amount: '500000.00',
    status: 'approved_unlinked',
    directLinkTarget: null,
    allocations: [{ status: 'active', targetId: PI, targetKind: 'submission', amount: '500000.00' }],
    attributionComplete: true,
    expected: {
      orderLinked: '0',
      piLinked: '500000.00',
      available: '0.00',
      allocationCount: 1,
      verification: 'verified',
      overAllocated: false,
      views: ['all', 'pi_drafts'],
    },
    note: 'Fully PI-linked. It must appear under PI Drafts and under no other '
        + 'narrowing — an advance on a PI is not Order money and is not free.',
  },

  /** The mixed case the whole classification exists for. */
  J_mixed: {
    label: 'J',
    paymentId: '22222222-0000-0000-0000-000000000022',
    amount: '1000000.00',
    status: 'approved_unlinked',
    directLinkTarget: null,
    allocations: [
      { status: 'active', targetId: X,  targetKind: 'order',      amount: '300000.00' },
      { status: 'active', targetId: PI, targetKind: 'submission', amount: '450000.00' },
    ],
    attributionComplete: true,
    expected: {
      orderLinked: '300000.00',
      piLinked: '450000.00',
      available: '250000.00',
      allocationCount: 2,
      verification: 'verified',
      overAllocated: false,
      views: ['all', 'orders', 'pi_drafts', 'available'],
    },
    note: 'Split between an Order and a PI with money left over. It appears in '
        + 'ALL FOUR views, which is the case a single-bucket classification '
        + 'would have to lie about.',
  },

  /** Money that arrived with nothing pointing at it. */
  K_unallocated: {
    label: 'K',
    paymentId: '33333333-0000-0000-0000-000000000033',
    amount: '250000.00',
    status: 'approved_unlinked',
    directLinkTarget: null,
    allocations: [],
    attributionComplete: true,
    expected: {
      orderLinked: '0',
      piLinked: '0',
      available: '250000.00',
      allocationCount: 0,
      verification: 'verified',
      overAllocated: false,
      views: ['all', 'available'],
    },
    note: 'Nothing points at it, so all of it is available. This is the queue '
        + 'that needs somebody to act.',
  },

  /** Awaiting verification, and separately attributed. */
  L_awaiting: {
    label: 'L',
    paymentId: '44444444-0000-0000-0000-000000000044',
    amount: '400000.00',
    status: 'pending_approval',
    directLinkTarget: null,
    allocations: [{ status: 'active', targetId: X, targetKind: 'order', amount: '100000.00' }],
    attributionComplete: true,
    expected: {
      orderLinked: '100000.00',
      piLinked: '0',
      available: '300000.00',
      allocationCount: 1,
      verification: 'awaiting',
      overAllocated: false,
      views: ['all', 'orders', 'available'],
    },
    note: 'Awaiting money is classified exactly like verified money and reported '
        + 'under its own verification state. It is never ADDED to verified '
        + 'totals — the two axes stay separate — but it is real and allocatable.',
  },

  /** Refused money, which is not money. */
  M_rejected: {
    label: 'M',
    paymentId: '55555555-0000-0000-0000-000000000055',
    amount: '900000.00',
    status: 'rejected',
    directLinkTarget: null,
    allocations: [],
    attributionComplete: true,
    expected: {
      orderLinked: '0',
      piLinked: '0',
      available: '900000.00',
      allocationCount: 0,
      verification: 'rejected',
      overAllocated: false,
      // NOT in `all`. A rejected payment is excluded from the classified set by
      // status, before any figure is computed.
      views: [],
    },
    note: 'A rejected payment is excluded from every view including All. Its '
        + 'figures are still computed truthfully so nothing depends on them '
        + 'being blank, but no narrowing may return it.',
  },

  /** Paise, and a split that only balances in exact decimal arithmetic. */
  N_paise: {
    label: 'N',
    paymentId: '66666666-0000-0000-0000-000000000066',
    amount: '1000.03',
    status: 'approved_linked',
    directLinkTarget: null,
    allocations: [
      { status: 'active', targetId: X,  targetKind: 'order',      amount: '333.34' },
      { status: 'active', targetId: PI, targetKind: 'submission', amount: '333.33' },
    ],
    attributionComplete: true,
    expected: {
      orderLinked: '333.34',
      piLinked: '333.33',
      available: '333.36',
      allocationCount: 2,
      verification: 'verified',
      overAllocated: false,
      views: ['all', 'orders', 'pi_drafts', 'available'],
    },
    note: 'Exact decimal arithmetic. 1000.03 - 333.34 - 333.33 is 333.36 and '
        + 'nothing else; a float would produce 333.35999999999996 and a '
        + 'conservation check that never quite holds.',
  },

  /**
   * The reader who may see the payment but not all of its allocations. The
   * balance is WITHHELD rather than overstated.
   */
  O_incomplete: {
    label: 'O',
    paymentId: '77777777-0000-0000-0000-000000000077',
    amount: '1000000.00',
    status: 'approved_unlinked',
    directLinkTarget: null,
    // What this reader can SEE. There is more, elsewhere, that they cannot.
    allocations: [{ status: 'active', targetId: PI2, targetKind: 'submission', amount: '200000.00' }],
    attributionComplete: false,
    expected: {
      orderLinked: '0',
      piLinked: '200000.00',
      available: null,
      allocationCount: 1,
      verification: 'verified',
      overAllocated: false,
      // Present in PI Drafts, because what they see is genuinely theirs.
      // ABSENT from Available, because an incomplete sum understates the
      // attribution and would overstate the free balance.
      views: ['all', 'pi_drafts'],
    },
    note: 'A PI participant sees the allocation onto their own PI and no other. '
        + 'The balance is null, not 800000 — telling them there is free money '
        + 'when there is not is the one error direction that must never happen.',
  },
}

/** The fixture keys, in the order the assertions walk them. */
export const CLASSIFICATION_FIXTURE_ORDER = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G_pi', 'H_replaced',
  'I_pi_only', 'J_mixed', 'K_unallocated', 'L_awaiting', 'M_rejected',
  'N_paise', 'O_incomplete',
] as const
