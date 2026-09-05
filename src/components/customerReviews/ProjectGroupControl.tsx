'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { AWAITING_IMAGES_LABEL, imageReadiness } from '@/lib/customerReviews/reviewTypes'
import {
  REVIEW_IMAGE_GROUP_COLUMNS,
  type ReviewImageGroup,
  type TestCard,
} from '@/lib/customerReviews/types'

// ── Which project an image review posts photographs of ───────────────────────
//
// THE GROUP IS NORMALLY CHOSEN BY THE DATABASE, not here.
// assign_customer_review_batch() gives a batch's four image reviews four
// DIFFERENT ready groups, least-recently-used first. This control is the path
// for the case that selection cannot cover: an image review assigned when there
// were not four ready projects, which is then waiting for its photographs.
//
// ATTACHING A GROUP IS WHAT MAKES A REVIEW READY. There is no separate flag to
// raise, no status to move and nothing else to remember —
// `image_group_id is not null` and the group holding at least one live image is
// the whole of the definition, in the browser and in the conditional UPDATE
// that books the review.
//
// IT IS REFUSED ONCE A CANDIDATE HAS BOOKED THE REVIEW.
// set_customer_review_image_group() allows `pending_approval` and `available`
// and nothing beyond, because from the moment somebody picks the review up the
// photographs are what they were told to post. This component asks the same
// question before drawing a control, and the database is what decides.
//
// ONLY READY GROUPS ARE OFFERED. A group with no live images would produce a
// review that has a project and is still not ready, which is precisely the
// state this control exists to leave.

type Option = ReviewImageGroup & { image_count: number }

export function ProjectGroupControl({
  supabase, card, onChanged,
}: {
  supabase: SupabaseClient
  card: Pick<TestCard, 'id' | 'status' | 'review_type' | 'image_group_id'>
  onChanged: () => void | Promise<void>
}) {
  const [groups, setGroups] = useState<Option[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  const editable = card.status === 'pending_approval' || card.status === 'available'
  const applicable = card.review_type === 'image'

  useEffect(() => {
    if (!applicable || !editable) return
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data: groupRows, error: readError } = await supabase
          .from('customer_review_image_groups')
          .select(REVIEW_IMAGE_GROUP_COLUMNS)
          .is('archived_at', null)
          .order('label', { ascending: true })
        if (!active) return
        if (readError) { setGroups([]); setError('The project list could not be loaded.'); return }

        const rows = (groupRows ?? []) as unknown as ReviewImageGroup[]
        if (rows.length === 0) { setGroups([]); return }

        // ONE MORE REQUEST, NOT ONE PER GROUP: every live image for every group
        // in a single `in`, counted here.
        const { data: imageRows } = await supabase
          .from('customer_review_group_images')
          .select('group_id')
          .in('group_id', rows.map(g => g.id))
          .is('removal_started_at', null)
        if (!active) return

        const counts = new Map<string, number>()
        for (const row of (imageRows ?? []) as { group_id: string }[]) {
          counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1)
        }
        setGroups(
          rows
            .map(g => ({ ...g, image_count: counts.get(g.id) ?? 0 }))
            // A group with nothing in it is not an option; offering one would
            // let a verifier "fix" a waiting review into a review that is still
            // waiting.
            .filter(g => g.image_count > 0),
        )
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase, applicable, editable])

  const attach = useCallback(async (groupId: string) => {
    if (inFlight.current || !groupId) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('set_customer_review_image_group', {
        p_card_id: card.id,
        p_group_id: groupId,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That project could not be attached.')
        return
      }
      await onChanged()
    } catch {
      setError('That project could not be attached. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [supabase, card.id, onChanged])

  // A TEXT REVIEW HAS NO PROJECT TO SHOW OR CHOOSE. Rendering an empty section
  // for one would be answering a question nobody asked.
  if (!applicable) return null

  const ready = imageReadiness(card) === 'ready'

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
      <h4 style={{
        margin: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: colors.tertiary,
      }}>
        Project images
      </h4>

      {!editable ? (
        <p style={{ margin: 0, fontSize: '11px', color: colors.secondary, lineHeight: 1.6 }}>
          {ready
            ? 'Project attached. A candidate has picked this review up, so it is now fixed.'
            : 'No project attached, and a candidate is already holding this review.'}
        </p>
      ) : (
        <>
          <p style={{
            margin: 0, fontSize: '12px', lineHeight: 1.6,
            color: ready ? '#166534' : '#92400E', fontWeight: 600,
          }}>
            {ready ? 'Ready — a project group is attached.' : AWAITING_IMAGES_LABEL}
          </p>

          {groups === null ? (
            <p style={{ margin: 0, fontSize: '11px', color: colors.muted }}>Loading projects…</p>
          ) : groups.length === 0 ? (
            <p style={{ margin: 0, fontSize: '11px', color: colors.secondary, lineHeight: 1.6 }}>
              No project group has images yet. Add one in the Image Library, then attach it here.
            </p>
          ) : (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <label htmlFor={`group-${card.id}`} style={{ fontSize: '12px', color: colors.secondary }}>
                {ready ? 'Change to' : 'Attach'}
              </label>
              <select
                id={`group-${card.id}`}
                defaultValue=""
                disabled={busy}
                onChange={e => { void attach(e.target.value) }}
                className="boe-input"
                style={{ maxWidth: '260px', minHeight: '40px', fontSize: '13px' }}
              >
                <option value="">Choose a project</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.label} · {g.image_count} image{g.image_count === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              {busy && <Loader2 size={14} className="boe-spin" style={{ color: colors.secondary }} />}
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.6 }}>{error}</p>
      )}
    </section>
  )
}
