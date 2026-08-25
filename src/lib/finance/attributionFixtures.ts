// ── The attribution fixtures, A–F ─────────────────────────────────────────────
//
// ONE DEFINITION OF THE WORKED EXAMPLES, consumed by both sides of the parity
// check:
//
//   TypeScript  paymentAttribution.test.ts runs the rule over these directly
//   SQL         supabase/tests/payment_attribution_assertions.sql inserts the
//               same rows and asserts the same figures
//
// They are the examples from the business decision, verbatim, and they exist as
// data rather than as prose in two files so the two implementations cannot be
// tested against subtly different scenarios. attributionParity.test.ts asserts
// that the SQL fixture file really does carry every one of them.
//
// THE TWO SIDES NOW DISAGREE, DELIBERATELY AND IN ONE PLACE. The application
// dropped the direct-link fallback when Link/Unlink were retired: attribution
// comes from active allocation rows and nothing else. The SQL function
// order_linked_payment_total() STILL APPLIES THE FALLBACK, because changing it
// needs a migration and none was in scope.
//
// So a fixture whose payment has a direct link and NO active allocation is
// scored differently by the two sides, and `sqlExpected` records what the SQL
// still says. Exactly two fixtures are affected — A and E — and the parity test
// asserts that: it pins the SIZE of the divergence, so the follow-up migration
// that removes the SQL fallback can delete these fields and the test will
// confirm the two sides agree again.
//
// Amounts are strings, because that is how `numeric` crosses the wire and the
// whole point is that nothing passes through a float on its way to a decision.

export type FixtureAllocation = {
  /** 'active' counts; 'reversed' is a withdrawn claim and counts for nothing. */
  status: 'active' | 'reversed'
  /** Which Order or PI this allocation names. */
  targetId: string
  targetKind: 'order' | 'submission'
  amount: string
}

export type AttributionFixture = {
  /** The letter from the business decision. */
  label: string
  paymentId: string
  amount: string
  /** The Order the payment's own order_id names, or null. */
  directLinkTarget: string | null
  allocations: FixtureAllocation[]
  /** What each target must be attributed, by the rule the APPLICATION applies. */
  expected: Record<string, string>
  /** The whole-payment figures, as the application computes them. */
  expectedUnallocated: string
  expectedState: 'unallocated' | 'partial' | 'full' | 'over'
  /**
   * What order_linked_payment_total() still says, where it differs — it retains
   * the direct-link fallback the application dropped. Absent when the two agree,
   * which is every fixture that has an active allocation. Delete these along
   * with the SQL fallback.
   */
  sqlExpected?: Record<string, string>
  sqlExpectedUnallocated?: string
  sqlExpectedState?: 'unallocated' | 'partial' | 'full' | 'over'
  /** F alone: conservation is deliberately broken and must stay visible. */
  overAllocated?: true
  /** Why this case exists, for the reader of a failing assertion. */
  note: string
}

const X = 'ORDER_X'
const Y = 'ORDER_Y'
const PI = 'SUBMISSION_P'

export const ATTRIBUTION_FIXTURES: Record<string, AttributionFixture> = {
  A: {
    label: 'A',
    paymentId: 'aaaaaaaa-0000-0000-0000-00000000000a',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [],
    expected: { [X]: '0' },
    expectedUnallocated: '1000000.00',
    expectedState: 'unallocated',
    sqlExpected: { [X]: '1000000.00' },
    sqlExpectedUnallocated: '0',
    sqlExpectedState: 'full',
    note: 'A dormant link and no allocation row. THE APPLICATION ATTRIBUTES '
        + 'NOTHING: allocation rows are the only source, so this is Zero '
        + 'Allocated and free in full. The SQL still applies the fallback and '
        + 'credits X the whole payment — the one divergence, recorded above.',
  },

  B: {
    label: 'B',
    paymentId: 'bbbbbbbb-0000-0000-0000-00000000000b',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [{ status: 'active', targetId: X, targetKind: 'order', amount: '500000.00' }],
    expected: { [X]: '500000.00' },
    expectedUnallocated: '500000.00',
    expectedState: 'partial',
    note: 'An allocation exists, so it is authoritative even though it names the '
        + 'same Order the link does. The legacy ₹10L must not be counted.',
  },

  C: {
    label: 'C',
    paymentId: 'cccccccc-0000-0000-0000-00000000000c',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [{ status: 'active', targetId: Y, targetKind: 'order', amount: '400000.00' }],
    // X IS OVERRIDDEN TO ZERO. This is the defect's headline case: the old rule
    // gave X its full ₹10L on top of Y's ₹4L.
    expected: { [X]: '0', [Y]: '400000.00' },
    expectedUnallocated: '600000.00',
    expectedState: 'partial',
    note: 'The link points at X and the money went to Y. Total attribution is '
        + '₹4L, never ₹14L.',
  },

  D: {
    label: 'D',
    paymentId: 'dddddddd-0000-0000-0000-00000000000d',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [
      { status: 'active', targetId: X, targetKind: 'order', amount: '400000.00' },
      { status: 'active', targetId: Y, targetKind: 'order', amount: '600000.00' },
    ],
    expected: { [X]: '400000.00', [Y]: '600000.00' },
    expectedUnallocated: '0.00',
    expectedState: 'full',
    note: 'Split across two Orders, summing to the payment. Each gets its own '
        + 'share and nothing is left over.',
  },

  E: {
    label: 'E',
    paymentId: 'eeeeeeee-0000-0000-0000-00000000000e',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [{ status: 'reversed', targetId: Y, targetKind: 'order', amount: '400000.00' }],
    expected: { [X]: '0', [Y]: '0' },
    expectedUnallocated: '1000000.00',
    expectedState: 'unallocated',
    sqlExpected: { [X]: '1000000.00', [Y]: '0' },
    sqlExpectedUnallocated: '0',
    sqlExpectedState: 'full',
    note: 'A reversed allocation is a withdrawn claim and counts for nothing, '
        + 'which leaves no active row at all — so this behaves exactly as A: '
        + 'Zero Allocated for the application, fallback for the SQL.',
  },

  F: {
    label: 'F',
    paymentId: 'ffffffff-0000-0000-0000-00000000000f',
    amount: '1000000.00',
    directLinkTarget: null,
    allocations: [{ status: 'active', targetId: X, targetKind: 'order', amount: '1500000.00' }],
    expected: { [X]: '1500000.00' },
    expectedUnallocated: '0.00',
    expectedState: 'over',
    overAllocated: true,
    note: 'Unreachable through any current write path — the capacity trigger '
        + 'refuses it and the amount guard refuses to lower a payment into it — '
        + 'so a row here is legacy data needing a person. The excess stays '
        + 'visible; individual allocations are never capped.',
  },

  /**
   * NOT one of the lettered examples, but a reachable combination question 8
   * asks about explicitly: a payment linked to an Order and allocated to a PI.
   * The rule does not care what KIND the target is — an active allocation is
   * authoritative, so the Order's link is overridden just as in C.
   */
  G_pi: {
    label: 'G',
    paymentId: '99999999-0000-0000-0000-000000000009',
    amount: '1000000.00',
    directLinkTarget: X,
    allocations: [{ status: 'active', targetId: PI, targetKind: 'submission', amount: '250000.00' }],
    expected: { [X]: '0', [PI]: '250000.00' },
    expectedUnallocated: '750000.00',
    expectedState: 'partial',
    note: 'Legacy-linked to an Order, actively allocated to a PI. The Order is '
        + 'overridden the same way it is by an allocation to another Order.',
  },

  /**
   * Also from question 8: an inactive row coexisting with an active replacement,
   * which is exactly what correcting an allocation produces — reverse, then
   * re-allocate.
   */
  H_replaced: {
    label: 'H',
    paymentId: '88888888-0000-0000-0000-000000000008',
    amount: '1000000.00',
    directLinkTarget: null,
    allocations: [
      { status: 'reversed', targetId: X, targetKind: 'order', amount: '900000.00' },
      { status: 'active',   targetId: Y, targetKind: 'order', amount: '300000.00' },
    ],
    expected: { [X]: '0', [Y]: '300000.00' },
    expectedUnallocated: '700000.00',
    expectedState: 'partial',
    note: 'A corrected allocation: the reversed row stays in the trail with its '
        + 'reason, and only the active replacement counts.',
  },
}

/** The fixture letters, in the order the business decision lists them. */
export const FIXTURE_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G_pi', 'H_replaced'] as const
