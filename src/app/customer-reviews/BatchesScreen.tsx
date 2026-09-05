'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { GenerateDrafts } from '@/components/customerReviews/GenerateDrafts'
import { PendingBatches } from '@/components/customerReviews/PendingBatches'
import { AssignBatchPanel, assignmentNotice } from '@/components/customerReviews/AssignBatch'
import { DeleteReviewsSheet } from '@/components/customerReviews/DeleteReviews'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { fetchAllRows } from '@/lib/supabasePaging'
import type { ApprovalMode } from '@/lib/customerReviews/status'
import {
  DRAFT_BATCH_COLUMNS,
  TEST_CARD_PENDING_COLUMNS,
  type ApprovalResult,
  type DeletionCounts,
  type DraftBatch,
  type TestCard,
} from '@/lib/customerReviews/types'
import { StackSkeleton } from '@/components/customerReviews/ReviewSkeletons'

// ── Generate → Review → Approve → Assign, in one workspace ───────────────────
//
// WHY THIS PAGE EXISTS. Batch work used to be spread across three places on one
// screen: the generator at the top, the drafts under a "Pending approval" tab,
// and the assignment control inside a collapsed foldaway back at the top again.
// The journey is linear and the UI made you hunt for each step. It reads in
// order here, and each step is where the previous one leaves you.
//
// NOTHING ABOUT THE RULES MOVED. Generation, approval and assignment call the
// same RPCs with the same arguments; this file composes the same three
// components the list screen used to hold.

export function BatchesScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [cards, setCards] = useState<TestCard[]>([])
  const [batches, setBatches] = useState<Map<string, DraftBatch>>(new Map())
  const [actorNames, setActorNames] = useState<Map<string, string>>(new Map())
  const [availableTotal, setAvailableTotal] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<null | { cards: TestCard[]; source: 'single' | 'selected' }>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const acting = useRef(false)

  const load = useCallback(async () => {
    if (!profile) return

    const result = await fetchAllRows<TestCard>(
      (from, to) => supabase
        .from('customer_review_test_cards')
        .select(TEST_CARD_PENDING_COLUMNS)
        .eq('status', 'pending_approval')
        .is('deleted_at', null)
        .order('card_ref', { ascending: true })
        .range(from, to),
    )
    if (!result.ok) {
      setError('The pending drafts could not be loaded. Refresh to try again.')
      setCards([])
      setLoaded(true)
      return
    }
    setError(null)
    setCards(result.rows)

    // HOW MANY REVIEWS A REPLACE WOULD DISPLACE — unassigned only, matching
    // what customer_review_replace_available() actually does. `head: true`
    // fetches no rows.
    const { count } = await supabase
      .from('customer_review_test_cards')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'available')
      .is('assigned_to', null)
      .is('deleted_at', null)
    setAvailableTotal(count ?? 0)

    // TWO MORE REQUESTS, NOT ONE PER CARD: the batch ids collected from the
    // rows already in hand, then the people who generated them.
    const batchIds = Array.from(new Set(result.rows.map(r => r.batch_id).filter((id): id is string => !!id)))
    if (batchIds.length > 0) {
      const { data: batchRows } = await supabase
        .from('customer_review_draft_batches')
        .select(DRAFT_BATCH_COLUMNS)
        .in('id', batchIds)
      const rows = (batchRows ?? []) as unknown as DraftBatch[]
      setBatches(new Map(rows.map(b => [b.id, b])))

      const actorIds = Array.from(new Set(rows.map(b => b.generated_by)))
      if (actorIds.length > 0) {
        // Named columns, never `*` — a `select('*')` against public.users is a
        // permission error in this project.
        const { data: people } = await supabase.from('users').select('id, full_name').in('id', actorIds)
        const named = (people ?? []) as unknown as { id: string; full_name: string | null }[]
        setActorNames(new Map(named.map(p => [p.id, p.full_name ?? 'a verifier'])))
      }
    } else {
      setBatches(new Map())
    }
    setLoaded(true)
  }, [supabase, profile])

  // BATCH WORK IS VERIFIER-ONLY, so the page turns a candidate away rather
  // than rendering a generator whose route would refuse them. The RPCs resolve
  // `verify` again and are what actually decide.
  useEffect(() => {
    if (authLoading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [authLoading, caps.canVerify, router])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const runApproval = useCallback(async (
    rpc: 'approve_customer_review_drafts' | 'approve_customer_review_draft_batch',
    args: Record<string, unknown>,
  ) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { data, error: rpcError } = await supabase.rpc(rpc, args)
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That could not be approved.')
        await load()
        return
      }
      // THE COUNTS ARE THE DATABASE'S, NOT THE BROWSER'S. Both functions choose
      // and lock their sets inside the transaction, so what comes back is what
      // actually happened.
      const result = (data ?? {}) as Partial<ApprovalResult>
      const n = result.approved ?? 0
      const replaced = result.replaced ?? 0
      setNotice(
        replaced > 0
          ? `${n} review${n === 1 ? '' : 's'} approved, replacing ${replaced} that ${replaced === 1 ? 'was' : 'were'} available.`
          : `${n} review${n === 1 ? '' : 's'} approved. Assign the batch below.`,
      )
      await load()
    } catch {
      setError('That could not be approved. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, load])

  const approve = useCallback(
    (ids: string[], mode: ApprovalMode) => runApproval('approve_customer_review_drafts', {
      p_card_ids: ids, p_replace: mode === 'replace',
    }),
    [runApproval],
  )
  const approveBatch = useCallback(
    (batchId: string, mode: ApprovalMode) => runApproval('approve_customer_review_draft_batch', {
      p_batch_id: batchId, p_replace: mode === 'replace',
    }),
    [runApproval],
  )

  const runDelete = useCallback(async () => {
    if (!deleting || acting.current) return
    acting.current = true
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('delete_customer_review_test_cards', {
        p_card_ids: deleting.cards.map(c => c.id),
        p_source: deleting.source,
      })
      if (rpcError) {
        setDeleteError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'Those reviews could not be deleted.')
        await load()
        return
      }
      const counts = (data ?? {}) as Partial<DeletionCounts>
      const n = counts.deleted ?? 0
      setDeleting(null)
      setNotice(`${n} review${n === 1 ? '' : 's'} deleted.`)
      await load()
    } catch {
      setDeleteError('Those reviews could not be deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setDeleteBusy(false)
    }
  }, [supabase, deleting, load])

  if (authLoading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Batches"
      subtitle="Generate, approve and assign"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>

        {/* 1. GENERATE */}
        <GenerateDrafts onGenerated={() => { void load() }} />

        {notice && (
          <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>{notice}</p>
        )}
        {error && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        {/* 2 and 3. REVIEW AND APPROVE */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
          <SectionHeading
            title="Awaiting approval"
            hint={loaded ? `${cards.length} draft${cards.length === 1 ? '' : 's'}` : null}
          />
          {!loaded ? (
            <StackSkeleton count={2} height={168} />
          ) : cards.length === 0 ? (
            <Empty>No drafts are awaiting approval. Generate a batch to start.</Empty>
          ) : (
            <PendingBatches
              supabase={supabase}
              cards={cards}
              batches={batches}
              actorNames={actorNames}
              availableCount={availableTotal}
              busy={busy}
              onApprove={approve}
              onApproveBatch={approveBatch}
              onDelete={(targets, source) => { setDeleteError(null); setDeleting({ cards: targets, source }) }}
              onRevised={() => { void load() }}
              onCardChanged={() => { void load() }}
            />
          )}
        </section>

        {/* 4. ASSIGN */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
          <SectionHeading title="Ready to assign" hint={null} />
          <AssignBatchPanel
            supabase={supabase}
            onAssigned={outcome => { setNotice(assignmentNotice(outcome)); void load() }}
          />
        </section>
      </div>

      {deleting && (
        <DeleteReviewsSheet
          cards={deleting.cards}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => { void runDelete() }}
          onCancel={() => { if (!deleteBusy) { setDeleting(null); setDeleteError(null) } }}
        />
      )}
    </CustomerReviewsLayout>
  )
}

function SectionHeading({ title, hint }: { title: string; hint: string | null }) {
  return (
    <header style={{ display: 'flex', alignItems: 'baseline', gap: '9px', flexWrap: 'wrap' }}>
      <h2 style={{
        margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
        textTransform: 'uppercase', color: colors.primary,
      }}>
        {title}
      </h2>
      {hint && <span style={{ fontSize: '12px', color: colors.secondary }}>{hint}</span>}
    </header>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      margin: 0, padding: '18px', borderRadius: '9px', fontSize: '12px', lineHeight: 1.6,
      border: `1px dashed ${colors.border}`, color: colors.muted,
    }}>
      {children}
    </p>
  )
}
