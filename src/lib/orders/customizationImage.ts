// ── Regenerating a product picture for a customization ───────────────────────
//
// The client picks a standard product; sales then agree a change — a marble top
// instead of wood, a round top instead of a square one, a longer table on two
// bases. This module holds the pure rules for turning that into a picture:
// the suggestions offered, the instruction sent to the image model, and what
// an instruction may be. The paid call and the storage are in
// src/app/api/orders/pi-edits/regenerate-image/route.ts.
//
// No React, no network: every rule is a function a test can pin.

/** Model that edits a picture from a written instruction. One request per press. */
export const PI_IMAGE_EDIT_MODEL = 'fal-ai/flux-pro/kontext'

export const MIN_INSTRUCTION_LENGTH = 3
export const MAX_INSTRUCTION_LENGTH = 600

/** One-tap additions to the instruction. `text` is appended as its own sentence. */
export const CUSTOMIZATION_CHIPS: readonly { label: string; text: string }[] = [
  { label: 'Marble top', text: 'Change the table top to white marble with natural grey veining.' },
  { label: 'Wooden top', text: 'Change the table top to natural solid wood with visible grain.' },
  { label: 'Round top', text: 'Change the top from its current shape to a perfectly round top.' },
  { label: 'Square top', text: 'Change the top from its current shape to a square top.' },
  { label: 'Longer, two bases', text: 'Make the table noticeably longer with a longer top, supported by two identical bases evenly spaced.' },
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

/**
 * The prompt sent to the model. The change is the person's words; around it,
 * fixed rules keep everything they did NOT mention the same, because the
 * operations team reads this picture as "the standard product, with exactly
 * this difference".
 */
export function buildEditPrompt(instruction: string): string {
  const change = instruction.trim().replace(/\s+/g, ' ')
  return [
    `Edit this furniture product photograph. Required change: ${change}`,
    'Keep everything not mentioned in the change identical: the same product style, proportions, materials, colours, camera angle, lighting and plain studio background.',
    'Show the whole product, complete and centred. Do not add people, text, logos, labels or extra objects.',
  ].join(' ')
}

/** Where a generated picture is rejected before it is stored. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024
