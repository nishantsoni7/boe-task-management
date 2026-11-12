// Phase 4, Image studio: what the picture route asks the image model to do with a quotation product picture.
// "Clean up" redraws an unclear client picture (WhatsApp photo, screenshot, blurred PDF image) as a sharp catalogue
// picture of the SAME design; "Change it" applies a typed change, reusing Edit PI's tested prompt. Pure, so the
// route's rules are pinned by tests.

import { buildEditPrompt } from '@/lib/orders/customizationImage'

export type StudioMode = 'clean' | 'change'

/** The same shape the database accepts for a quotation picture (20270614000000). */
export const QUOTATION_PICTURE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/

export const MAX_INSTRUCTION = 400
export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024

export const CLEAN_UP_PROMPT = [
  'This is a picture of one furniture product sent by a client; it may be blurred, dark, cropped, photographed at an angle, a screenshot, or taken from a document.',
  'Redraw it as a sharp, well-lit catalogue product photograph of exactly the same design.',
  'Keep the same shape, proportions, number of parts, legs, arms, cushions, materials, colours and patterns. Do not redesign, simplify or add anything.',
  'Plain white studio background with a soft natural shadow, the whole product visible and centred, a slight three-quarter front view if the original allows it.',
  'Remove any text, watermark, logo, measurements, arrows, people, room or other objects.',
].join(' ')

export function studioPrompt(mode: StudioMode, instruction: string, hasReference: boolean): string {
  return mode === 'clean' ? CLEAN_UP_PROMPT : buildEditPrompt(instruction, hasReference ? 1 : 0)
}

/** Why a request cannot be sent; null when it can. Checked before anything is paid for. */
export function studioProblem(mode: unknown, sourcePath: unknown, instruction: unknown): string | null {
  if (mode !== 'clean' && mode !== 'change') return 'Choose Clean up or Change it.'
  if (typeof sourcePath !== 'string' || !QUOTATION_PICTURE_PATH.test(sourcePath)) return 'Pick a saved product picture first.'
  if (mode === 'change') {
    const t = typeof instruction === 'string' ? instruction.trim() : ''
    if (t.length < 3) return 'Say what to change, for example "walnut finish" or "add arms".'
    if (t.length > MAX_INSTRUCTION) return `Keep the change under ${MAX_INSTRUCTION} characters.`
  }
  return null
}

/** A reference picture sent as a JPEG/PNG/WebP data URL, or null for none; false when it is unusable. */
export function readReference(value: unknown): { mime: string; base64: string } | null | false {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return false
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!m) return false
  if (Math.floor((m[2].length * 3) / 4) > MAX_REFERENCE_BYTES) return false
  return { mime: m[1], base64: m[2] }
}
