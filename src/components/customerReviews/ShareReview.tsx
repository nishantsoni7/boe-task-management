'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, Share2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { buildReviewMessage } from '@/lib/customerReviews/internalTest'
import { REVIEW_IMAGE_BUCKET } from '@/lib/customerReviews/reviewImages'
import {
  MANUAL_ATTACH_INSTRUCTION,
  downloadFileName,
  isShareableReview,
  shareCapability,
} from '@/lib/customerReviews/sharing'
import { testCategoryLabel, type TestCard, type TestCardPhoto } from '@/lib/customerReviews/types'

// ── Handing an approved review to the share sheet ────────────────────────────
//
// WHAT THIS DOES. It gathers the review's text and its attached images and
// hands both to `navigator.share`. The operating system opens its own sheet;
// the person picks WhatsApp, picks a recipient, and presses send.
//
// WHAT IT DOES NOT DO, AND CANNOT
//   * IT DOES NOT SEND ANYTHING. There is no WhatsApp Business API in this
//     repository, no Meta credential, no template and no outbound request in
//     this file. Every word of copy below is written to avoid implying
//     otherwise: the button says "Share review", the success state says the
//     sheet was opened, and nothing anywhere says "sent".
//   * IT DOES NOT TOUCH A PENDING DRAFT. isShareableReview() is asked first and
//     the control is not rendered at all when the answer is no. Nothing about a
//     review awaiting approval leaves this application.
//   * IT DOES NOT MAKE ANYTHING PUBLIC. The images are fetched through
//     short-lived signed URLs, in the browser, under the same policy that
//     governs reading the card. No public URL is minted and nothing is uploaded
//     anywhere.
//
// ── THE TWO PATHS, AND WHY THE FALLBACK IS NOT A LESSER ONE ────────────────
//
// `canShare` IS ASKED BEFORE `share`, with the real files. A browser that has
// `share` but cannot take these files does not fail gracefully on its own — it
// rejects, sometimes after the sheet has already flickered open.
//
// When files cannot go, the fallback does the two things the share sheet would
// have done, separately: the text goes to the clipboard and the images are
// saved to the device. It deliberately does NOT fall back to a text-only share,
// because that would send a review about furniture without the pictures of it,
// silently, and the sender would never know. See shareCapability().
//
// THE EXISTING TEXT-ONLY WHATSAPP WORKFLOW IS UNTOUCHED. WhatsAppLaunch still
// asks the server for a wa.me link for a booked card with no images involved.
// This is a different control for a different moment, and neither replaces the
// other.

const SIGNED_URL_TTL_SECONDS = 300

type ShareState =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** The sheet was opened. NOT "sent" — we cannot know that, and never claim it. */
  | { kind: 'opened' }
  /** Text copied and images saved; the person finishes the job by hand. */
  | { kind: 'manual' }
  | { kind: 'error'; message: string }

export function ShareReviewButton({
  supabase,
  card,
  images,
}: {
  supabase: SupabaseClient
  card: TestCard
  /** Live images only. The caller's query filters removals out. */
  images: TestCardPhoto[]
}) {
  const [state, setState] = useState<ShareState>({ kind: 'idle' })
  const inFlight = useRef(false)

  // THE GATE, ASKED BEFORE ANYTHING IS RENDERED. A pending draft has no share
  // control at all — not a disabled one, which would be a thing to try to
  // enable.
  const shareable = isShareableReview(card)

  const run = useCallback(async () => {
    if (inFlight.current) return
    // Re-asked at the moment of action, not only at render. The row may have
    // been refreshed since this button was drawn.
    if (!isShareableReview(card)) {
      setState({ kind: 'error', message: 'Only an approved review can be shared.' })
      return
    }
    inFlight.current = true
    setState({ kind: 'working' })

    try {
      const text = buildReviewMessage({
        title: card.test_title,
        body: card.test_body,
        categoryLabel: testCategoryLabel(card.test_category),
        reference: card.card_ref,
      })
      const title = card.test_title

      const files = await loadImageFiles(supabase, card, images)

      const capability = shareCapability(
        typeof navigator === 'undefined' ? undefined : (navigator as unknown as Parameters<typeof shareCapability>[0]),
        { title, text, files },
      )

      if (capability.kind === 'files' || capability.kind === 'text') {
        try {
          await navigator.share(
            capability.kind === 'files' ? { title, text, files } : { title, text },
          )
          setState({ kind: 'opened' })
          return
        } catch (err) {
          // A DISMISSED SHEET IS NOT A FAILURE. The user closing the share sheet
          // rejects with AbortError, and reporting that as an error would tell
          // somebody their deliberate choice went wrong.
          if (err instanceof DOMException && err.name === 'AbortError') {
            setState({ kind: 'idle' })
            return
          }
          // Anything else falls through to the manual path rather than dead-ending.
        }
      }

      await copyAndDownload(text, files)
      setState({ kind: 'manual' })
    } catch {
      setState({ kind: 'error', message: 'That review could not be prepared for sharing. Try again.' })
    } finally {
      inFlight.current = false
    }
  }, [supabase, card, images])

  if (!shareable) return null

  const working = state.kind === 'working'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={run}
          disabled={working}
          className="boe-btn boe-btn-primary"
          style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
        >
          {working
            ? <Loader2 size={13} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />
            : <Share2 size={13} strokeWidth={2} />}
          {working ? 'Preparing…' : 'Share review'}
        </button>
        <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
          {images.length > 0
            ? `The review and its ${images.length} image${images.length === 1 ? '' : 's'}.`
            : 'The review text.'}
        </span>
      </div>

      {/*
        role="status" so every outcome is announced. The wording is chosen so
        that no state claims a message was sent — because none of them knows.
      */}
      <span role="status" style={{ fontSize: '11px', lineHeight: 1.55, color: state.kind === 'error' ? colors.red : colors.tertiary }}>
        {state.kind === 'opened'
          ? 'Your share sheet was opened. Choose WhatsApp and the recipient there, then press send yourself — BOE does not send anything for you.'
          : state.kind === 'manual'
            ? MANUAL_ATTACH_INSTRUCTION
            : state.kind === 'error'
              ? state.message
              : ' '}
      </span>
    </div>
  )
}

/**
 * The attached images, as Files the share sheet will accept.
 *
 * Fetched in the BROWSER through short-lived signed URLs, which are governed by
 * the same SELECT policy that decides who may read the card. A viewer who has
 * lost access gets no URL and therefore no file — the same answer the rest of
 * the module gives.
 *
 * AN IMAGE THAT WILL NOT LOAD IS SKIPPED, not fatal. Four images and one
 * expired signature should share three images, not refuse the review.
 */
async function loadImageFiles(
  supabase: SupabaseClient,
  card: TestCard,
  images: TestCardPhoto[],
): Promise<File[]> {
  if (images.length === 0) return []

  const paths = images.map(i => i.storage_path)
  const { data } = await supabase.storage
    .from(REVIEW_IMAGE_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
  if (!data) return []

  const files: File[] = []
  for (let index = 0; index < data.length; index++) {
    const signed = data[index]?.signedUrl
    if (!signed) continue
    try {
      const response = await fetch(signed)
      if (!response.ok) continue
      const blob = await response.blob()
      const image = images[index]
      files.push(new File([blob], downloadFileName(card.card_ref, index, image.mime_type), {
        type: image.mime_type,
      }))
    } catch {
      // One unreadable object does not stop the others.
    }
  }
  return files
}

/**
 * The fallback: the text on the clipboard, the images on the device.
 *
 * Both halves are attempted independently, because a clipboard refused by
 * permission policy should not cost somebody their images.
 */
async function copyAndDownload(text: string, files: File[]) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch {
    // Reported through the instruction sentence rather than as a separate
    // failure — the person can still select the review text on screen.
  }

  for (const file of files) {
    const url = URL.createObjectURL(file)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      // Revoked on the next tick: revoking synchronously can cancel the
      // download the click has only just started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  }
}
