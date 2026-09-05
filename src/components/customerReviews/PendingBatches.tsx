'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import { ReviewFullView } from './ReviewFullView'
import { ReviseDrafts } from './ReviseDrafts'
import { ApprovalChoiceCards } from './ApprovalChoice'
import { DeleteReviewButton } from './DeleteReviews'
import { DraftEditedNote, EditDraftActions, EditDraftFields, useDraftEditor } from './EditDraft'
import { ReviewImageManager } from './ReviewImageManager'
import { ReviewTypeBadge } from './AssignedReviews'
import { ReviewTypeControl } from './ReviewTypeControl'
import { ProjectGroupControl } from './ProjectGroupControl'
import { ProjectImages, useProjectImages } from './ProjectImages'
import type { ApprovalMode } from '@/lib/customerReviews/status'
import {
  TEST_CARD_PHOTO_COLUMNS,
  formatTestTimestamp,
  testCategoryLabel,
  type DraftBatch,
  type TestCard,
  type TestCardPhoto,
} from '@/lib/customerReviews/types'
import { REVIEW_IMAGE_KIND } from '@/lib/customerReviews/reviewImages'

// ── The verifier's Pending approval workspace ────────────────────────────────
//
// Drafts are grouped by the batch that produced them, because approval is a
// judgement about a batch's guidance as much as about twelve separate reviews:
// "these all sound the same" is a thing you can only see when they are together.
//
// FOUR THINGS A VERIFIER MAY DO TO A DRAFT BEFORE APPROVING IT, and all four
// live inside the full-view sheet rather than on the tile, for the reason
// booking lives at the end of a read: a correction made from a 130-character
// preview is a correction made without the text in front of you.
//
//   EDIT     replace the title and the body. Saving does not approve — the
//            draft comes back to this list still awaiting approval.
//   TYPE     correct a draft between text and image. THIS IS THE ONLY WINDOW in
//            which that is possible: once a review is approved and assigned, its
//            type decides both what the candidate was asked to do and what they
//            are paid, so changing it would rewrite the price of work already
//            under way.
//   PROJECT  attach the project image group an image review posts photographs
//            of. Attaching one is what makes the review Ready; it is also
//            offered later, from the detail screen, for a review that was
//            assigned before its project existed. The group's photographs are
//            shown read-only beneath it, so an image review is not approved
//            blind.
//   IMAGES   attach up to four photographs of the furniture — FOR A TEXT REVIEW
//            ONLY. An image review's photographs are its project group's, and
//            that is the whole of it: the share sheet carries the GROUP's
//            images, so drawing the per-card manager beside the project picker
//            would offer two ways to attach and honour only one.
//
// All four are refused by the server once a review is approved (PROJECT stays
// open one step longer, until a candidate actually books the review), and none
// is offered here for anything that is not pending.
//
// THREE WAYS TO APPROVE, and they are the three the workflow asks for:
//   * one review, from its own row;
//   * a selection, from the batch's toolbar;
//   * everything still pending in the batch, from the same toolbar.
//
// SELECTION IS SCOPED TO ONE BATCH, deliberately. approve_customer_review_drafts
// takes at most a batch's worth of ids, the bulk actions read "in this batch",
// and a selection that silently spanned two batches would make "Approve all
// pending" ambiguous about which "all" it meant.
//
// THE BULK ACTIONS ARE NOT EASY TO HIT BY ACCIDENT. Both go through a
// confirmation sheet naming the exact count, and neither is the first control
// in the batch header. Approving one review is a single press because it
// affects one review.
//
// A DISABLED CONTROL SAYS WHY. "Approve selected" with nothing chosen is
// disabled AND carries the sentence explaining it, rather than being a grey
// rectangle somebody presses three times.
//
// EVERY CHECK HERE IS THE WEAKEST OF THREE. The screen renders this only for
// caps.canVerify; approve_customer_review_drafts() resolves `verify` again from
// the permission engine and is what actually decides. A verifier whose
// permission is revoked while this page is open gets a refusal, not a silent
// success.

type Props = {
  /** For the short-lived signed URLs the image thumbnails are drawn from. */
  supabase: SupabaseClient
  /** Pending drafts only. The caller's query is what makes that true. */
  cards: TestCard[]
  /** The batches those drafts came from, by id. A missing one still renders. */
  batches: Map<string, DraftBatch>
  /** Display names for the people who generated them, by user id. */
  actorNames: Map<string, string>
  /**
   * How many reviews are available to candidates right now.
   *
   * Read by the screen, not derived here — this workspace only ever holds
   * PENDING drafts, so it has no way to count the pool it is being asked about.
   * It is what makes "Replace" able to say how many reviews it would displace.
   */
  availableCount: number | null
  busy: boolean
  onApprove: (ids: string[], mode: ApprovalMode) => Promise<void>
  onApproveBatch: (batchId: string, mode: ApprovalMode) => Promise<void>
  /** Opens the deletion confirmation the screen owns. */
  onDelete: (cards: TestCard[], source: 'single' | 'selected') => void
  onRevised: () => void
  /**
   * Reload after an edit or an image change.
   *
   * Separate from onRevised even though the caller passes the same reload, so
   * neither name has to lie: a revision is a model rewriting a batch, and this
   * is a person changing one draft.
   */
  onCardChanged: () => void
}

export function PendingBatches({
  supabase, cards, batches, actorNames, availableCount, busy,
  onApprove, onApproveBatch, onDelete, onRevised, onCardChanged,
}: Props) {
  // Grouped by batch, batches newest first, drafts by reference within one.
  const groups = useMemo(() => {
    const byBatch = new Map<string, TestCard[]>()
    for (const card of cards) {
      const key = card.batch_id ?? 'unbatched'
      const list = byBatch.get(key)
      if (list) list.push(card)
      else byBatch.set(key, [card])
    }
    return Array.from(byBatch.entries())
      .map(([batchId, list]) => ({
        batchId,
        batch: batches.get(batchId) ?? null,
        cards: [...list].sort((a, b) => a.card_ref.localeCompare(b.card_ref)),
      }))
      .sort((a, b) => {
        const at = a.batch?.generated_at ?? ''
        const bt = b.batch?.generated_at ?? ''
        return bt.localeCompare(at)
      })
  }, [cards, batches])

  if (cards.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {groups.map(group => (
        <BatchGroup
          key={group.batchId}
          supabase={supabase}
          batchId={group.batchId}
          batch={group.batch}
          cards={group.cards}
          actorNames={actorNames}
          availableCount={availableCount}
          busy={busy}
          onApprove={onApprove}
          onApproveBatch={onApproveBatch}
          onDelete={onDelete}
          onRevised={onRevised}
          onCardChanged={onCardChanged}
        />
      ))}
    </div>
  )
}

function BatchGroup({
  supabase, batchId, batch, cards, actorNames, availableCount, busy,
  onApprove, onApproveBatch, onDelete, onRevised, onCardChanged,
}: {
  supabase: SupabaseClient
  batchId: string
  batch: DraftBatch | null
  cards: TestCard[]
  actorNames: Map<string, string>
  availableCount: number | null
  busy: boolean
  onApprove: (ids: string[], mode: ApprovalMode) => Promise<void>
  onApproveBatch: (batchId: string, mode: ApprovalMode) => Promise<void>
  onDelete: (cards: TestCard[], source: 'single' | 'selected') => void
  onRevised: () => void
  onCardChanged: () => void
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [showGuidance, setShowGuidance] = useState(false)
  const [reading, setReading] = useState<TestCard | null>(null)
  const [confirm, setConfirm] = useState<
    null | { kind: 'selected' | 'all' | 'one'; count: number; ids: string[] }
  >(null)
  /**
   * ADD IS THE DEFAULT, AND IT RESETS WITH EVERY CONFIRMATION.
   *
   * The state lives beside `confirm` rather than outside it so that closing a
   * sheet and opening another cannot carry a Replace forward into an approval
   * the verifier meant to add. `setConfirm` and `setMode('add')` always move
   * together for that reason.
   */
  const [mode, setMode] = useState<ApprovalMode>('add')

  const openConfirm = useCallback(
    (next: { kind: 'selected' | 'all' | 'one'; count: number; ids: string[] }) => {
      setMode('add')
      setConfirm(next)
    },
    [],
  )

  const pendingCount = cards.length
  const allSelected = selected.size === pendingCount && pendingCount > 0

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected(prev => (prev.size === cards.length ? new Set() : new Set(cards.map(c => c.id))))
  }, [cards])

  const runConfirmed = useCallback(async () => {
    if (!confirm) return
    if (confirm.kind === 'all') await onApproveBatch(batchId, mode)
    else await onApprove(confirm.ids, mode)
    setSelected(new Set())
    setConfirm(null)
    setMode('add')
  }, [confirm, mode, onApprove, onApproveBatch, batchId])

  const generatedBy = batch ? (actorNames.get(batch.generated_by) ?? 'a verifier') : null

  return (
    <section
      aria-label={batch ? `Batch generated ${formatTestTimestamp(batch.generated_at)}` : 'Ungrouped drafts'}
      style={{
        border: `1px solid ${colors.border}`, borderRadius: '10px',
        background: '#FFFFFF', overflow: 'hidden',
      }}
    >
      {/* ── Batch header: the facts, without dominating the drafts ── */}
      <header style={{
        padding: '12px 14px', borderBottom: `1px solid ${colors.border}`,
        background: colors.raised, display: 'flex', flexDirection: 'column', gap: '9px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '13px', color: colors.primary }}>
            {pendingCount} awaiting approval
          </strong>
          {batch && (
            <span style={{ fontSize: '11px', color: colors.tertiary }}>
              of {batch.card_count} · generated {formatTestTimestamp(batch.generated_at)} by {generatedBy} · {batch.model}
            </span>
          )}
        </div>

        {batch && (
          <div>
            <button
              type="button"
              onClick={() => setShowGuidance(v => !v)}
              aria-expanded={showGuidance}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                background: 'transparent', border: 'none', padding: '4px 0',
                minHeight: '44px', cursor: 'pointer',
                fontSize: '12px', color: colors.blue, fontFamily: 'inherit',
              }}
            >
              {showGuidance ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
              {showGuidance ? 'Hide the guidance' : 'Show the guidance these came from'}
            </button>
            {showGuidance && (
              <p style={{
                margin: '4px 0 0', padding: '9px 11px', borderRadius: '8px',
                background: '#FFFFFF', border: `1px solid ${colors.border}`,
                fontSize: '12px', color: colors.secondary, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              }}>
                {batch.guidance}
              </p>
            )}
          </div>
        )}
      </header>

      {/* ── Selection toolbar ── */}
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      }}>
        {/* The label is the hit area here too, and it is already 44px tall. */}
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: '10px',
          minHeight: '44px', paddingRight: '6px',
          cursor: 'pointer', fontSize: '12px', color: colors.secondary,
        }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            style={{ width: '18px', height: '18px', flexShrink: 0 }}
          />
          Select all {pendingCount} in this batch
        </label>

        <span style={{ fontSize: '12px', color: colors.tertiary }}>
          {selected.size} selected
        </span>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => openConfirm({
              kind: 'selected', count: selected.size, ids: Array.from(selected),
            })}
            disabled={selected.size === 0 || busy}
            className="boe-btn boe-btn-primary"
            style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
          >
            Approve selected
          </button>
          <button
            type="button"
            onClick={() => openConfirm({ kind: 'all', count: pendingCount, ids: [] })}
            disabled={busy}
            className="boe-btn boe-btn-ghost"
            style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
          >
            Approve all {pendingCount}
          </button>
          {batch && (
            <ReviseDrafts batchId={batchId} pendingCount={pendingCount} onRevised={onRevised} />
          )}
          {/*
            DELETING A SELECTION SITS LAST IN THE ROW, after Approve and Revise.
            It is the same selection the approve action uses, so a verifier who
            has ticked four drafts can discard them without ticking again — and
            it is a ghost button in danger colour rather than a primary one,
            because the control that throws work away should not be where the
            thumb lands by habit.
          */}
          <DeleteReviewButton
            compact
            label={selected.size > 0 ? `Delete ${selected.size}` : 'Delete selected'}
            disabled={selected.size === 0 || busy}
            onClick={() => onDelete(cards.filter(c => selected.has(c.id)), 'selected')}
          />
        </div>

        {/*
          THE DISABLED REASON, IN WORDS. A grey button with no explanation is a
          button people press repeatedly; this is the one sentence that stops
          that, and it is only rendered when the button is actually off.
        */}
        {selected.size === 0 && (
          <p style={{ margin: 0, flexBasis: '100%', fontSize: '11px', color: colors.muted, lineHeight: 1.4 }}>
            Tick one or more reviews to use “Approve selected”, or approve the whole batch.
          </p>
        )}
      </div>

      {/* ── The drafts ── */}
      <ul style={{
        listStyle: 'none', margin: 0, padding: '12px',
        display: 'grid', gap: '10px',
        // Two per row where there is room, one where there is not. The minimum
        // is what decides it, so no media query and no resize listener.
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
      }}>
        {cards.map(card => (
          <PendingDraftRow
            key={card.id}
            card={card}
            checked={selected.has(card.id)}
            busy={busy}
            onToggle={() => toggle(card.id)}
            onRead={() => setReading(card)}
            onApproveOne={() => openConfirm({ kind: 'one', count: 1, ids: [card.id] })}
            onDeleteOne={() => onDelete([card], 'single')}
          />
        ))}
      </ul>

      {/* ── Reading one draft in full, and correcting it ── */}
      {reading && (
        <ReadDraftSheet
          supabase={supabase}
          card={reading}
          busy={busy}
          onClose={() => setReading(null)}
          onApproveOne={() => {
            const c = reading
            setReading(null)
            openConfirm({ kind: 'one', count: 1, ids: [c.id] })
          }}
          onDeleteOne={() => { const c = reading; setReading(null); onDelete([c], 'single') }}
          onChanged={onCardChanged}
        />
      )}

      {/*
        ── The approval confirmation, and the Add/Replace choice ──

        ONE SHEET FOR ALL THREE APPROVAL SCOPES. Approving a single draft used
        to be a bare tap; it now goes through here too, because every approval
        has to answer the same question about the list that is already there.
        The sheet is the only place that question is asked.
      */}
      {confirm && (
        <ReviewSheet
          title={confirm.kind === 'all'
            ? `Approve all ${confirm.count} pending reviews?`
            : confirm.count === 1
              ? 'Approve this review?'
              : `Approve ${confirm.count} selected reviews?`}
          subtitle={
            availableCount === null
              ? undefined
              : availableCount === 0
                ? 'Nothing is available to candidates right now'
                : `${availableCount} review${availableCount === 1 ? ' is' : 's are'} available to candidates right now`
          }
          maxWidth="520px"
          onClose={() => { if (!busy) { setConfirm(null); setMode('add') } }}
          footer={
            <>
              <button
                type="button"
                onClick={runConfirmed}
                disabled={busy}
                className="boe-btn boe-btn-primary"
                style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
              >
                {busy && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
                {busy
                  ? 'Approving…'
                  // THE PRIMARY ACTION NAMES THE CHOICE, not just the count.
                  // "Yes, approve 12" reads the same whichever card is ticked,
                  // and the two outcomes are not the same.
                  : mode === 'replace'
                    ? `Approve ${confirm.count} and replace the list`
                    : `Approve ${confirm.count} and keep the list`}
              </button>
              <button
                type="button"
                onClick={() => { setConfirm(null); setMode('add') }}
                disabled={busy}
                className="boe-btn boe-btn-ghost"
                style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
              >
                Cancel
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            {confirm.count === 1 ? 'This review becomes' : `These ${confirm.count} reviews become`} available
            for any candidate to book and send. Approval cannot be undone from this screen.
          </p>

          <ApprovalChoiceCards
            mode={mode}
            onChange={setMode}
            approveCount={confirm.count}
            availableCount={availableCount ?? 0}
            disabled={busy}
          />

          <p style={{ margin: 0, fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.55 }}>
            {confirm.kind === 'all'
              ? 'Everything still awaiting approval in this batch is released together, or nothing is.'
              : confirm.count === 1
                ? 'If it has already been approved by somebody else, nothing changes and you can try again.'
                : 'The whole selection is approved together, or none of it is — if one of them has already been approved by somebody else, nothing changes and you can try again.'}
            {mode === 'replace' && ' The replacement happens in the same step, so either both parts happen or neither does.'}
          </p>
        </ReviewSheet>
      )}
    </section>
  )
}

/**
 * One pending draft, read in full — and, when the verifier asks, edited.
 *
 * TWO MODES IN ONE SHEET, not two sheets. A verifier who presses Edit is
 * looking at the same review they were reading a moment ago; throwing the sheet
 * away and opening another loses their scroll position and their place in the
 * batch for no gain.
 *
 * THE FOOTER CHANGES WITH THE MODE, and that is the point of ReviewSheet's
 * pinned footer: while editing, the only actions are Save and Cancel. Approve
 * is not one of them. A verifier cannot approve a draft in the same press that
 * saves it, because those are two decisions and conflating them is how unread
 * text gets released.
 *
 * IMAGES ARE LOADED HERE, NOT WITH THE LIST. A batch is twelve drafts; querying
 * every draft's images to render twelve tiles would be twelve queries for
 * thumbnails nobody has asked to see. They are fetched when a draft is opened.
 */
function ReadDraftSheet({
  supabase, card, busy, onClose, onApproveOne, onDeleteOne, onChanged,
}: {
  supabase: SupabaseClient
  card: TestCard
  busy: boolean
  onClose: () => void
  onApproveOne: () => void
  onDeleteOne: () => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [images, setImages] = useState<TestCardPhoto[]>([])
  /**
   * The row as it is on screen right now.
   *
   * A save updates this immediately from what the server returned, so the full
   * view behind the editor shows the new text without waiting for the list
   * query to come back. `onChanged` still fires, so the list catches up too.
   */
  const [current, setCurrent] = useState<TestCard>(card)

  /**
   * The project images this draft would post, for the read-only display below.
   *
   * Read through the VERIFIER'S OWN client, so RLS decides — the same read the
   * candidate's screen makes, which is what keeps the two showing the same set.
   * A text review passes null and the hook does no work.
   */
  const projectImages = useProjectImages(
    supabase,
    current.review_type === 'image' ? current.image_group_id : null,
  )

  const loadImages = useCallback(async () => {
    const { data } = await supabase
      .from('customer_review_test_card_screenshots')
      .select(TEST_CARD_PHOTO_COLUMNS)
      .eq('card_id', card.id)
      .eq('kind', REVIEW_IMAGE_KIND)
      // A row marked for removal is already gone as far as every reader is
      // concerned — the same filter the rest of the module applies.
      .is('removal_started_at', null)
      .order('image_slot', { ascending: true })
    setImages((data ?? []) as unknown as TestCardPhoto[])
  }, [supabase, card.id])

  // A FETCH IS STARTED HERE; NO STATE IS SET HERE. Every setState inside
  // loadImages runs after its first await, so this effect performs no
  // synchronous state update and there is no cascading render to worry about.
  // The named function is the shape TestCardDetailScreen already uses for the
  // same reason — it is what makes that true to the linter as well as to a
  // reader.
  useEffect(() => {
    const startFetch = () => { void loadImages() }
    startFetch()
  }, [loadImages])

  const editor = useDraftEditor(current, async updated => {
    setCurrent(prev => ({
      ...prev,
      test_title: updated.test_title,
      test_body: updated.test_body,
      // Stamped locally so the "Edited by a verifier" note appears at once. The
      // authoritative value arrives with the next list load.
      draft_edited_at: prev.draft_edited_at ?? new Date().toISOString(),
    }))
    setEditing(false)
    onChanged()
  })

  return (
    <ReviewSheet
      title={editing ? 'Edit this draft' : current.test_title}
      subtitle={`${current.card_ref} · ${testCategoryLabel(current.test_category)} · awaiting your approval`}
      maxWidth="560px"
      // Not dismissable by backdrop while editing: a stray tap outside the
      // sheet should not discard something somebody has typed.
      dismissOnBackdrop={!editing && !editor.saving}
      onClose={() => { if (!editor.saving) onClose() }}
      footer={
        editing ? (
          <EditDraftActions editor={editor} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <button
              type="button"
              onClick={onApproveOne}
              disabled={busy}
              className="boe-btn boe-btn-primary"
              style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
            >
              Approve this review
            </button>
            {/*
              EDIT SITS BESIDE APPROVE, not inside a menu. A verifier reading a
              draft that is nearly right should not have to hunt for the way to
              fix it — that is the moment the whole feature exists for.
            */}
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={busy}
              className="boe-btn boe-btn-ghost"
              style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
            >
              <Pencil size={13} strokeWidth={2} />
              Edit
            </button>
            {/*
              DELETING FROM THE FULL VIEW is where a verifier who has just read
              a bad draft actually is, so the action is offered there — still
              secondary, still behind its own confirmation.
            */}
            <DeleteReviewButton disabled={busy} onClick={onDeleteOne} />
            <button
              type="button"
              onClick={onClose}
              className="boe-btn boe-btn-ghost"
              style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
            >
              Close
            </button>
          </>
        )
      }
    >
      {editing ? (
        <EditDraftFields editor={editor} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/*
            THE PROVENANCE, KEPT HONEST. The AI-generated warning inside
            ReviewFullView still says where the draft came from; this says a
            person has since changed it. Both, because both are true.
          */}
          {current.draft_edited_at && (
            <div><DraftEditedNote card={current} /></div>
          )}
          <ReviewFullView card={current} canBook={false} bookError={null} />
          {/*
            THE TYPE, AND THE ONLY PLACE IT MAY BE CORRECTED. It sits between
            the review's words and its images because that is the order the
            decision happens in: you read the draft, you decide what kind of
            review it is, and only then does attaching pictures make sense.
          */}
          <ReviewTypeControl
            supabase={supabase}
            card={current}
            onChanged={onChanged}
          />
          <ProjectGroupControl
            supabase={supabase}
            card={current}
            onChanged={onChanged}
          />
          {/*
            WHAT THE CANDIDATE WILL ACTUALLY POST, shown to the verifier before
            they approve it. The picker above names the project and its count;
            this is the photographs themselves, so approving an image review is
            not done blind. Read-only — the library is where a project's images
            are managed.
          */}
          {current.review_type === 'image' && current.image_group_id && (
            <ProjectImages supabase={supabase} set={projectImages} label={null} />
          )}
          {/*
            THE PER-CARD IMAGE MANAGER, FOR A TEXT REVIEW ONLY.

            AN IMAGE REVIEW'S PHOTOGRAPHS ARE ITS PROJECT GROUP'S, and the
            control for that is ProjectGroupControl directly above. Rendering
            both for one image review would put two ways to attach photographs
            side by side — and only one of them is what the candidate actually
            posts, because ShareReviewButton carries the GROUP's images. A
            verifier filling in the wrong one would produce a review that looks
            prepared and shares nothing of what they attached.

            NOTHING IS REMOVED FOR A TEXT REVIEW. The per-card attachment, its
            table, its bucket and its route are all untouched; this decides
            which control is drawn, and nothing else.
          */}
          {current.review_type !== 'image' && (
            <ReviewImageManager
              supabase={supabase}
              cardId={current.id}
              images={images}
              onChanged={async () => { await loadImages(); onChanged() }}
              // Pending, always — this sheet is only rendered from the pending
              // workspace. The server refuses anything else regardless.
              canEdit={current.status === 'pending_approval'}
            />
          )}
        </div>
      )}
    </ReviewSheet>
  )
}

function PendingDraftRow({
  card, checked, busy, onToggle, onRead, onApproveOne, onDeleteOne,
}: {
  card: TestCard
  checked: boolean
  busy: boolean
  onToggle: () => void
  onRead: () => void
  onApproveOne: () => void
  onDeleteOne: () => void
}) {
  const preview = card.test_body.length > 130
    ? `${card.test_body.slice(0, 130).trimEnd()}…`
    : card.test_body

  return (
    <li style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '11px', borderRadius: '9px', minWidth: 0,
      border: `1px solid ${checked ? '#DDD6FE' : colors.border}`,
      background: checked ? '#FAF9FF' : colors.raised,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '2px' }}>
        {/*
          THE BOX IS 18px; THE THING YOU PRESS IS 44px.
          A bare checkbox is a 5mm target, which is a target people miss and
          then press twice. The padded label around it is the hit area, so the
          control a thumb has to find is comfortable without the tick itself
          becoming an oversized graphic. `htmlFor` is not needed — the input is
          inside the label — and the accessible name stays on the input so a
          screen reader announces which review is being selected.
        */}
        <label style={{
          display: 'inline-flex', alignItems: 'flex-start', justifyContent: 'center',
          minWidth: '44px', minHeight: '44px', paddingTop: '13px',
          flexShrink: 0, cursor: 'pointer', marginLeft: '-11px',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select ${card.card_ref}, ${card.test_title}`}
            style={{ width: '18px', height: '18px' }}
          />
        </label>
        <div style={{ flex: 1, minWidth: 0, paddingTop: '11px' }}>
          <div style={{ display: 'flex', gap: '7px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: colors.tertiary }}>
              {card.card_ref}
            </span>
            <span style={{ fontSize: '10px', color: colors.muted }}>
              {testCategoryLabel(card.test_category)}
            </span>
            {/*
              THE TYPE, ON THE TILE, because the composition of a batch is a
              thing a verifier checks at a glance: eight of one badge and four
              of the other. Seeing five image badges is how they notice a
              correction is needed before approving.
            */}
            <ReviewTypeBadge type={card.review_type} />
            {/*
              ON THE TILE TOO, not only inside the sheet. A verifier scanning
              twelve drafts should be able to see which ones somebody has
              already been through without opening each one.
            */}
            <DraftEditedNote card={card} compact />
          </div>
          <div style={{
            fontSize: '13px', fontWeight: 600, color: colors.primary,
            lineHeight: 1.4, overflowWrap: 'anywhere', marginTop: '2px',
          }}>
            {card.test_title}
          </div>
        </div>
      </div>

      <p style={{
        margin: 0, fontSize: '12px', color: colors.secondary,
        lineHeight: 1.55, overflowWrap: 'anywhere',
      }}>
        {preview}
      </p>

      <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '2px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onRead}
          className="boe-btn boe-btn-ghost"
          style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
        >
          Read in full
        </button>
        <button
          type="button"
          onClick={onApproveOne}
          disabled={busy}
          className="boe-btn boe-btn-primary"
          style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
        >
          Approve
        </button>
        {/*
          LAST IN THE ROW, AND VISUALLY LIGHTEST. Read in full and Approve are
          what a verifier presses; Delete is available on every draft without
          competing with them for the same tap.
        */}
        <DeleteReviewButton compact disabled={busy} onClick={onDeleteOne} />
      </div>
    </li>
  )
}
