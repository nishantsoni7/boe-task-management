// ── Regenerating a product picture for a customization ───────────────────────
//
// The client picks a standard product; sales then agree a change — a marble top
// instead of wood, a round top instead of a square one, a longer table on two
// bases sharing one floor plate. This module holds the pure rules for turning
// that into a picture, in two steps:
//
//   1. UNDERSTAND  Claude reads the salesperson's words (and any reference
//                  picture) with the product photo and writes the change out as
//                  exact physical instructions: shapes, counts, positions, what
//                  joins what, what is removed. The person checks and may edit
//                  it before anything is paid for on the image side.
//                  Route: src/app/api/orders/pi-edits/interpret-customization.
//   2. REGENERATE  The image model applies that instruction to the photo, using
//                  up to two reference pictures for the changed parts.
//                  Route: src/app/api/orders/pi-edits/regenerate-image.
//
// No React, no network: every rule is a function a test can pin.

/** Image model: edits a picture from an instruction plus reference images. One request per press. */
export const PI_IMAGE_EDIT_MODEL = 'fal-ai/nano-banana-pro/edit'

/** The model that turns sales wording into exact instructions. */
export const PI_INTERPRET_MODEL = 'claude-opus-5-5'

export const MIN_INSTRUCTION_LENGTH = 3
export const MAX_INSTRUCTION_LENGTH = 1500

/** Reference pictures (a catalogue photo, a phone sketch) for the changed parts. */
export const MAX_REFERENCES = 2
/** Each reference arrives already shrunk by the browser; this is a ceiling, not a target. */
export const MAX_REFERENCE_BYTES = 1.5 * 1024 * 1024
/** The browser shrinks a reference to fit inside this square before sending it. */
export const REFERENCE_MAX_SIDE = 1280

/** One-tap additions to the instruction. `text` is appended as its own sentence. */
export const CUSTOMIZATION_CHIPS: readonly { label: string; text: string }[] = [
  { label: 'Marble top', text: 'Change the table top to white marble with natural grey veining.' },
  { label: 'Wooden top', text: 'Change the table top to natural solid wood with visible grain.' },
  { label: 'Round top', text: 'Change the top from its current shape to a perfectly round top.' },
  { label: 'Square top', text: 'Change the top from its current shape to a square top.' },
  { label: 'Longer, two bases', text: 'Make the table noticeably longer with a longer top, supported by two identical bases evenly spaced.' },
  { label: 'One shared floor plate', text: 'Both bases stand on one single continuous floor plate that joins them, instead of a separate plate under each.' },
  { label: 'Single pedestal', text: 'Support the top with a single central pedestal base.' },
  { label: 'Black finish', text: 'Change the finish of the metal and frame to matte black.' },
  { label: 'Brass finish', text: 'Change the finish of the metal and frame to brushed brass.' },
]

/**
 * The instruction a person starts from: what sales already wrote under
 * Customization, so the suggestion is the customization and not a blank box.
 */
export function suggestInstruction(customization: string): string {
  const text = customization.trim().replace(/\s+/g, ' ')
  if (text === '') return ''
  return text.length > MAX_INSTRUCTION_LENGTH ? text.slice(0, MAX_INSTRUCTION_LENGTH).trimEnd() : text
}

/** Adds a chip's sentence once; a second tap on the same chip changes nothing. */
export function addChipToInstruction(instruction: string, chipText: string): string {
  const current = instruction.trim()
  if (current.includes(chipText)) return instruction
  const next = current === '' ? chipText : `${current.replace(/[.\s]*$/, '')}. ${chipText}`
  return next.length > MAX_INSTRUCTION_LENGTH ? instruction : next
}

export type InstructionProblem = 'too_short' | 'too_long'

export function instructionProblem(instruction: unknown): InstructionProblem | null {
  if (typeof instruction !== 'string') return 'too_short'
  const n = instruction.trim().length
  if (n < MIN_INSTRUCTION_LENGTH) return 'too_short'
  if (n > MAX_INSTRUCTION_LENGTH) return 'too_long'
  return null
}

export const INSTRUCTION_MESSAGES: Record<InstructionProblem, string> = {
  too_short: 'Say what should change, for example “marble top” or “round instead of square”.',
  too_long: `Keep the change to ${MAX_INSTRUCTION_LENGTH} characters or fewer.`,
}

// ── Reference pictures ───────────────────────────────────────────────────────

export type ReferenceImage = { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string }

/**
 * Reads the reference pictures a request carries: data URLs of JPEG, PNG or
 * WebP, at most MAX_REFERENCES, each at most MAX_REFERENCE_BYTES. Anything
 * else makes the whole list null, so the route refuses before spending.
 */
export function parseReferences(raw: unknown): ReferenceImage[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_REFERENCES) return null
  const out: ReferenceImage[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item)
    if (!m) return null
    const bytes = Math.floor((m[2].length * 3) / 4)
    if (bytes === 0 || bytes > MAX_REFERENCE_BYTES) return null
    out.push({ mimeType: m[1] as ReferenceImage['mimeType'], base64: m[2] })
  }
  return out
}

// ── Step 1: understanding the customization ──────────────────────────────────

/** What Claude returns: the exact instruction, and what it had to assume. */
export const INTERPRETATION_SCHEMA = {
  type: 'object',
  properties: {
    instruction: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['instruction', 'assumptions'],
  additionalProperties: false,
} as const

export type Interpretation = { instruction: string; assumptions: string[] }

/** Frozen, so it caches; everything per request goes in the user message. */
export const INTERPRET_SYSTEM_PROMPT = `You work for a furniture exporter. Salespeople describe how a client wants a standard product changed, often in short, informal or Hinglish wording. An image-editing model will then redraw the product photograph from your instruction. That model follows literal visual descriptions well but does not understand furniture trade terms, implied engineering, or measurements.

Write the instruction the image model needs. It must:
- Describe the FINAL product as it should look, part by part: the top (shape, proportions, material, edge), the base or legs (type, how many, where they stand), any floor plate, stretcher or frame (how many, its shape, what it connects), and the finishes.
- Say explicitly what joins what and what is removed or replaced. If one part is shared by several others (one plate under two pedestals, one frame joining four legs), say it is a single continuous piece and where it runs.
- Turn measurements into visible proportions (for example "about twice as long as it is wide"), because the image model cannot measure.
- Follow engineering sense where the salesperson implies it: a much longer top needs supports spread out under it; two pedestals under one long top stand near each end.
- Keep everything the salesperson did not ask to change: say it stays the same as in the photograph.
- When reference pictures are given, say which part to take from them and keep everything else from the product photograph.

Write the instruction as plain sentences, no headings, under 120 words. Put every guess you had to make into "assumptions", in short plain English the salesperson can check. Leave "assumptions" empty if nothing was guessed.

Example. Photograph: a square wooden table on one metal pedestal with a round floor plate. Salesperson: "longer rectangular table, 2 pedestal base to support, bottom plate combined".
Instruction: "Make the top a long rectangle, about two and a half times as long as it is wide, in the same wood and edge as the photograph. Replace the single pedestal with two identical metal pedestal columns of the same design, one standing under each end of the top. Remove the round floor plate. Both columns stand on ONE continuous flat rectangular metal plate on the floor that runs the length of the table and joins the two columns; there is no separate plate under each column. Keep the metal finish, camera angle and studio background as in the photograph."
Assumptions: ["Length about 2.5 times the width", "The shared plate is rectangular and matches the metal finish"]`

/** The user-turn text that goes with the product photo and any references. */
export function buildInterpretRequest(input: {
  comment: string
  productName: string
  dimensions: string
  material: string
  referenceCount: number
}): string {
  const lines = [
    `Salesperson's customization: ${input.comment.trim()}`,
    input.productName.trim() && `Product name: ${input.productName.trim()}`,
    input.dimensions.trim() && `Dimensions on the PI: ${input.dimensions.trim()}`,
    input.material.trim() && `Material on the PI: ${input.material.trim()}`,
    input.referenceCount > 0
      ? `The first image is the product photograph. The next ${input.referenceCount === 1 ? 'image is a reference picture' : `${input.referenceCount} images are reference pictures`} from the salesperson for the changed parts.`
      : 'The image is the product photograph.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** What came back, made safe to show and send on; null when it is unusable. */
export function readInterpretation(raw: unknown): Interpretation | null {
  const v = raw as Partial<Interpretation> | null
  if (!v || typeof v.instruction !== 'string') return null
  const instruction = v.instruction.trim().slice(0, MAX_INSTRUCTION_LENGTH)
  if (instructionProblem(instruction)) return null
  const assumptions = Array.isArray(v.assumptions)
    ? v.assumptions.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => a.trim().slice(0, 300)).slice(0, 6)
    : []
  return { instruction, assumptions }
}

// ── Step 2: the picture ──────────────────────────────────────────────────────

/**
 * The prompt sent to the image model. The change is the (checked) instruction;
 * around it, fixed rules keep everything not mentioned the same, because the
 * operations team reads this picture as "the standard product, with exactly
 * this difference".
 */
export function buildEditPrompt(instruction: string, referenceCount = 0): string {
  const change = instruction.trim().replace(/\s+/g, ' ')
  return [
    referenceCount > 0
      ? `Image 1 is a furniture product photograph to edit. ${referenceCount === 1 ? 'Image 2 is a reference picture' : `Images 2 to ${referenceCount + 1} are reference pictures`} showing how the changed parts should look; use them only for those parts.`
      : 'Edit this furniture product photograph.',
    `Required change: ${change}`,
    'Follow the change exactly, including how many of each part there are and which parts are joined into one piece.',
    'Keep everything not mentioned in the change identical to image 1: the same product style, materials, colours, camera angle, lighting and plain studio background.',
    'Show the whole product, complete and centred. Do not add people, text, logos, labels or extra objects.',
  ].join(' ')
}
