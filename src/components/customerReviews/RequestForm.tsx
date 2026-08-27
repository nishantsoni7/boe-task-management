'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle, Check } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  INTERACTION_TYPES,
  INTERACTION_TYPE_META,
  type CustomerReviewPhoto,
  type CustomerReviewRequest,
  type InteractionType,
} from '@/lib/customerReviews/types'
import { normalizeWhatsAppNumber } from '@/lib/customerReviews/contact'
import { parseReviewDestination } from '@/lib/customerReviews/destination'
import { buildInvitationMessage } from '@/lib/customerReviews/invitation'
import { readyToSendBlockers } from '@/lib/customerReviews/status'
import { InvitationPreview } from './InvitationPreview'
import { OutreachPrinciple } from './ReviewPieces'
import { PhotoManager } from './PhotoManager'
import { WhatsAppLaunchButton } from './WhatsAppLaunch'

// Create and edit, in one component, because they are the same form and two
// files would have drifted within a month.
//
// HOW THE TWO DIFFER, AND WHY
// A draft has to exist before a photograph can be attached to it — the storage
// policies key ownership off the request id in the object path. So creating is
// "fill in what you know, save", and the photo section says so plainly rather
// than showing a control that cannot work yet. After the first save the same
// form comes back in edit mode with photographs, the preview and the WhatsApp
// button live.
//
// WHAT IS SEPARATED HERE, VISUALLY AND STRUCTURALLY
//   INTERNAL — the note. It is for BOE, it never reaches the customer, and it
//              is not a parameter of buildInvitationMessage, so there is no
//              code path that could put it in the message.
//   CUSTOMER — the greeting, the project reference, and the preview.
// They sit in separate sections with separate headings for the same reason the
// database keeps them in separate columns: somebody in a hurry must not be able
// to confuse the two.
//
// THERE IS NO MESSAGE EDITOR. Two fields feed a fixed shape; the closing two
// sentences are a constant in src/lib/customerReviews/invitation.ts. That is
// the restriction, and it is structural rather than a rule somebody has to
// remember.

type Draft = {
  customerName: string
  whatsappInput: string
  interactionType: InteractionType | ''
  internalNote: string
  reviewUrl: string
  greetingName: string
  projectReference: string
  genuineConfirmed: boolean
  imagePermissionConfirmed: boolean
}

function draftFrom(request: CustomerReviewRequest | null): Draft {
  return {
    customerName:  request?.customer_name ?? '',
    whatsappInput: request?.whatsapp_number ?? '',
    interactionType: (request?.interaction_type ?? '') as InteractionType | '',
    internalNote:  request?.internal_note ?? '',
    reviewUrl:     request?.review_url ?? '',
    greetingName:  request?.greeting_name ?? '',
    projectReference: request?.project_reference ?? '',
    genuineConfirmed: request?.genuine_customer_confirmed ?? false,
    imagePermissionConfirmed: request?.image_permission_confirmed ?? false,
  }
}

export function RequestForm({
  supabase,
  userId,
  request,
  photos,
  onPhotosChanged,
  onSaved,
  onCancel,
  onToast,
}: {
  supabase: SupabaseClient
  userId: string
  /** null in create mode. */
  request: CustomerReviewRequest | null
  photos: CustomerReviewPhoto[]
  onPhotosChanged: () => void | Promise<void>
  onSaved: (requestId: string, markedReady: boolean) => void
  onCancel: () => void
  onToast: (message: string, variant?: 'success' | 'error' | 'info') => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(request))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  // State is too slow to stop a double click: two clicks in the same tick would
  // both read `saving === false`. The ref is what actually prevents a second
  // insert, and the disabled button is the part the user sees.
  const inFlight = useRef(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }))

  const projectPhotos = photos.filter(p => p.kind === 'project_photo')

  // ── Derived validation, recomputed as the employee types ────────────────────

  const phone = useMemo(
    () => (draft.whatsappInput.trim() === '' ? null : normalizeWhatsAppNumber(draft.whatsappInput)),
    [draft.whatsappInput],
  )
  const destination = useMemo(
    () => (draft.reviewUrl.trim() === '' ? null : parseReviewDestination(draft.reviewUrl)),
    [draft.reviewUrl],
  )

  const normalizedNumber = phone?.ok ? phone.e164 : null
  const normalizedUrl = destination?.ok ? destination.url : null

  // The SAME function the database runs in assert_customer_review_ready(). The
  // list here is what the employee sees; the database's copy is what decides.
  const blockers = readyToSendBlockers(
    {
      genuine_customer_confirmed: draft.genuineConfirmed,
      customer_name: draft.customerName,
      whatsapp_number: normalizedNumber,
      interaction_type: (draft.interactionType || null) as InteractionType | null,
      review_url: normalizedUrl,
      image_permission_confirmed: draft.imagePermissionConfirmed,
    },
    projectPhotos.length,
  )

  const message = buildInvitationMessage({
    greetingName: draft.greetingName,
    customerName: draft.customerName || 'there',
    projectReference: draft.projectReference,
    reviewUrl: normalizedUrl ?? '',
  })

  const previewIncomplete = !draft.customerName.trim()
    ? 'Add the customer or project name to see the invitation.'
    : !normalizedUrl
      ? 'Add the review link to see the exact invitation the customer will receive.'
      : null

  // ── Save ────────────────────────────────────────────────────────────────────

  const save = useCallback(async (markReady: boolean) => {
    if (inFlight.current) return
    setError(null)

    // Draft saving is lenient — an incomplete draft is a normal thing to have —
    // but three things are checked whatever the button, because each would
    // otherwise be stored wrong rather than merely missing: a name (the column
    // is NOT NULL), a number that is not a number, and a link that is not a
    // safe https address.
    if (draft.customerName.trim() === '') {
      setError('Add the customer or project name.')
      return
    }
    if (phone && !phone.ok) { setError(phone.error); return }
    if (destination && !destination.ok) { setError(destination.error); return }
    if (markReady && blockers.length > 0) {
      setError('Complete everything listed below before marking this Ready to Send.')
      return
    }

    inFlight.current = true
    setSaving(true)

    try {
      const fields = {
        customer_name: draft.customerName.trim(),
        whatsapp_number: normalizedNumber,
        interaction_type: draft.interactionType || null,
        internal_note: draft.internalNote.trim() || null,
        greeting_name: draft.greetingName.trim() || null,
        project_reference: draft.projectReference.trim() || null,
        review_url: normalizedUrl,
        genuine_customer_confirmed: draft.genuineConfirmed,
        image_permission_confirmed: draft.imagePermissionConfirmed,
      }

      let requestId = request?.id ?? null

      if (requestId) {
        const { error: updateError } = await supabase
          .from('customer_review_requests')
          .update(fields)
          .eq('id', requestId)
        if (updateError) { setError(friendly(updateError.message)); return }
      } else {
        // created_by is sent explicitly as well as defaulted, because the
        // INSERT policy compares it to auth.uid() — a row that omitted it would
        // rely on the default and the policy in the same statement.
        const { data, error: insertError } = await supabase
          .from('customer_review_requests')
          .insert({ ...fields, created_by: userId, status: 'draft' })
          .select('id')
          .single()
        if (insertError || !data) { setError(friendly(insertError?.message)); return }
        requestId = data.id as string
      }

      if (markReady) {
        // The transition is a separate call ON PURPOSE. Saving the fields and
        // claiming the request is ready are two decisions, and the second one
        // re-runs every prerequisite inside the database — including the
        // photograph-permission rule, which no client check can be trusted with
        // because it counts rows in another table.
        const { error: transitionError } = await supabase.rpc('transition_customer_review_request', {
          p_request_id: requestId,
          p_next_status: 'ready_to_send',
        })
        if (transitionError) {
          setError(friendly(transitionError.message))
          // The fields DID save, so this is reported rather than rolled back —
          // the employee wanted the save either way.
          //
          // Where it goes next differs by mode, and the difference matters. In
          // CREATE mode the draft now exists, so staying here would let a second
          // click raise a duplicate; the request screen takes over and shows
          // Draft, which claims nothing. In EDIT mode there is nothing to
          // duplicate, so the screen stays put with the reason on it.
          if (!request) onSaved(requestId, false)
          return
        }
      }

      onSaved(requestId, markReady)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }, [
    draft, phone, destination, blockers.length, normalizedNumber, normalizedUrl,
    request, supabase, userId, onSaved,
  ])

  const isReadyToSend = request?.status === 'ready_to_send'

  return (
    <div style={{ maxWidth: '780px' }}>
      <OutreachPrinciple />

      {error && (
        <div role="alert" style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
          fontSize: '13px', color: colors.red,
        }}>
          {error}
        </div>
      )}

      {/* ── 1. The confirmation the module refuses to work without ── */}
      <Section title="Who this is for">
        <Confirmation
          checked={draft.genuineConfirmed}
          onChange={value => set('genuineConfirmed', value)}
          label="This is a genuine BOE customer or project contact"
          hint="Somebody you have actually dealt with, about work BOE actually did."
        />

        <Field label="Customer or project name" required>
          <input
            className="boe-input"
            value={draft.customerName}
            maxLength={120}
            onChange={e => set('customerName', e.target.value)}
            placeholder="e.g. Anand Kumar, or Riverside Café"
            style={INPUT}
          />
        </Field>

        <Field
          label="WhatsApp number"
          hint="With the country code. A plain 10-digit Indian number gets +91 automatically."
        >
          <input
            className="boe-input"
            value={draft.whatsappInput}
            inputMode="tel"
            autoComplete="off"
            onChange={e => set('whatsappInput', e.target.value)}
            onBlur={() => { if (phone?.ok) set('whatsappInput', phone.e164) }}
            placeholder="+91 98765 43210"
            style={INPUT}
          />
          {phone && !phone.ok && (
            <FieldError>{phone.error}</FieldError>
          )}
          {phone?.ok && (
            <p style={HINT}>Will be saved as {phone.e164}. Only you, a verifier and an admin can see it.</p>
          )}
        </Field>

        <Field label="Interaction type">
          <select
            className="boe-input"
            value={draft.interactionType}
            onChange={e => set('interactionType', e.target.value as InteractionType | '')}
            style={{ ...INPUT, cursor: 'pointer' }}
          >
            <option value="">Choose…</option>
            {INTERACTION_TYPES.map(type => (
              <option key={type} value={type}>{INTERACTION_TYPE_META[type].label}</option>
            ))}
          </select>
        </Field>
      </Section>

      {/* ── 2. Internal. Kept apart from everything the customer sees. ── */}
      <Section
        title="Internal note"
        subtitle="For BOE only. This is never part of the WhatsApp message."
      >
        <textarea
          className="boe-input"
          value={draft.internalNote}
          maxLength={500}
          rows={3}
          onChange={e => set('internalNote', e.target.value)}
          placeholder="What happened, factually. e.g. Visited the factory on 12 Aug, ordered 40 café chairs, delivered on time."
          style={{ ...INPUT, resize: 'vertical', minHeight: '72px' }}
        />
        <p style={HINT}>{draft.internalNote.length}/500</p>
      </Section>

      {/* ── 3. Where the customer is sent ── */}
      <Section
        title="Review destination"
        subtitle="The public page the customer will open. It must be an https link."
      >
        <input
          className="boe-input"
          value={draft.reviewUrl}
          maxLength={500}
          onChange={e => set('reviewUrl', e.target.value)}
          placeholder="https://…"
          style={INPUT}
        />
        {destination && !destination.ok && <FieldError>{destination.error}</FieldError>}
        <p style={HINT}>
          BOE has no standing review link configured in this system, so paste the one you want
          this customer to use.
        </p>
      </Section>

      {/* ── 4. The invitation itself ── */}
      <Section
        title="The invitation"
        subtitle="You can change the greeting and the project reference. Nothing else."
      >
        <Field label="Greet them as" hint="Leave blank to use the customer or project name.">
          <input
            className="boe-input"
            value={draft.greetingName}
            maxLength={120}
            onChange={e => set('greetingName', e.target.value)}
            placeholder={draft.customerName || 'Customer name'}
            style={INPUT}
          />
        </Field>

        <Field
          label="Project reference"
          hint="A factual reminder of the job. Leave blank for “your furniture requirement”."
        >
          <input
            className="boe-input"
            value={draft.projectReference}
            maxLength={160}
            onChange={e => set('projectReference', e.target.value)}
            placeholder="e.g. your restaurant seating order"
            style={INPUT}
          />
        </Field>

        <div style={{ marginTop: '14px' }}>
          <InvitationPreview message={message} incomplete={previewIncomplete} />
        </div>
      </Section>

      {/* ── 5. Photographs ── */}
      <Section
        title="Project photographs"
        subtitle="Optional. Real photographs of this customer’s own project, for you to share alongside the message."
      >
        <PhotoManager
          supabase={supabase}
          requestId={request?.id ?? null}
          kind="project_photo"
          photos={projectPhotos}
          onChanged={onPhotosChanged}
          canAttach
          canRemove
          emptyHint="No photographs attached."
        />

        {projectPhotos.length > 0 && (
          <div style={{ marginTop: '12px' }}>
            <Confirmation
              checked={draft.imagePermissionConfirmed}
              onChange={value => set('imagePermissionConfirmed', value)}
              label="BOE has permission to share these photographs"
              hint="Required before this request can be marked Ready to Send."
            />
          </div>
        )}
      </Section>

      {/* ── 6. What is still missing ── */}
      {blockers.length > 0 && (
        <div style={{
          padding: '12px 14px', borderRadius: '9px', marginBottom: '16px',
          background: colors.amberTint, border: '1px solid rgba(232,160,48,0.28)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px',
            fontSize: '12px', fontWeight: 700, color: '#92400E',
          }}>
            <AlertTriangle size={13} strokeWidth={2.2} />
            Before this can be sent
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: colors.secondary, lineHeight: 1.7 }}>
            {blockers.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}

      {/* ── 7. Actions ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => save(false)}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '9px 18px', fontSize: '13px', opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : request ? 'Save changes' : 'Save draft'}
        </button>

        <button
          type="button"
          onClick={() => save(true)}
          disabled={saving || blockers.length > 0}
          className="boe-btn boe-btn-primary"
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '9px 18px', fontSize: '13px',
            opacity: saving || blockers.length > 0 ? 0.5 : 1,
            cursor: saving || blockers.length > 0 ? 'not-allowed' : 'pointer',
          }}
        >
          <Check size={14} strokeWidth={2.2} />
          Save &amp; mark Ready to Send
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
            border: `1px solid ${colors.border}`, background: 'transparent',
            color: colors.muted, cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>

      {/* The WhatsApp action lives on the form as well as the request screen,
          because the moment an employee finishes preparing an invitation is the
          moment they want to send it. It is offered only once the request is
          actually Ready to Send — before that there is nothing to open. */}
      {request && isReadyToSend && (
        <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: `1px solid ${colors.border}` }}>
          <WhatsAppLaunchButton
            supabase={supabase}
            requestId={request.id}
            whatsappNumber={request.whatsapp_number}
            message={buildInvitationMessage({
              greetingName: request.greeting_name,
              customerName: request.customer_name,
              projectReference: request.project_reference,
              reviewUrl: request.review_url ?? '',
            })}
            enabled={blockers.length === 0}
            onOpened={() => onToast('WhatsApp opened — press send there', 'info')}
            onError={m => onToast(m, 'error')}
          />
        </div>
      )}
    </div>
  )
}

// ── Small form pieces ─────────────────────────────────────────────────────────

const INPUT: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: '13px',
}

const HINT: React.CSSProperties = {
  fontSize: '11px', color: colors.muted, marginTop: '4px', lineHeight: 1.5,
}

function Section({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', padding: '16px 18px', marginBottom: '14px',
    }}>
      <h2 style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{title}</h2>
      {subtitle && (
        <p style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px', lineHeight: 1.5 }}>
          {subtitle}
        </p>
      )}
      <div style={{ marginTop: '12px' }}>{children}</div>
    </section>
  )
}

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: '12px' }}>
      <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.secondary, marginBottom: '4px' }}>
        {label}
        {required && <span style={{ color: colors.red }}> *</span>}
      </span>
      {children}
      {hint && <span style={{ ...HINT, display: 'block' }}>{hint}</span>}
    </label>
  )
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <span role="alert" style={{ display: 'block', fontSize: '11.5px', color: colors.red, marginTop: '4px' }}>
      {children}
    </span>
  )
}

/**
 * A confirmation, not a preference.
 *
 * Rendered as a large tappable row rather than a bare checkbox, because these
 * two are the statements the module refuses to work without and they are the
 * ones most likely to be ticked on a phone with a thumb.
 */
function Confirmation({
  checked, onChange, label, hint,
}: { checked: boolean; onChange: (value: boolean) => void; label: string; hint: string }) {
  return (
    <label style={{
      display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer',
      padding: '10px 12px', marginBottom: '12px', borderRadius: '9px',
      minHeight: '44px',
      background: checked ? colors.greenTint : colors.raised,
      border: `1px solid ${checked ? 'rgba(69,168,112,0.35)' : colors.borderSoft}`,
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ marginTop: '2px', width: '16px', height: '16px', flexShrink: 0, cursor: 'pointer' }}
      />
      <span>
        <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: '11px', color: colors.muted, marginTop: '2px', lineHeight: 1.5 }}>
          {hint}
        </span>
      </span>
    </label>
  )
}

/**
 * A database sentence an employee can act on.
 *
 * The RAISE messages in 20261017000000 are already written for a person and
 * carry no private data; this strips the machine-readable prefix and falls back
 * to something plain when PostgREST returns a bare constraint failure instead.
 */
function friendly(message: string | undefined): string {
  if (!message) return 'That could not be saved. Try again.'
  const cleaned = message.replace(/^[A-Z_]+:\s*/, '').trim()
  if (cleaned.includes('violates row-level security')) {
    return 'You do not have permission to change this request.'
  }
  if (cleaned.includes('check constraint') || cleaned.includes('violates')) {
    return 'Some of that could not be saved. Check the number and the review link.'
  }
  return cleaned || 'That could not be saved. Try again.'
}
