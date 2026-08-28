// The upload queue: what is selected, what state each item is in, and what may
// be generated next.
//
// Pure and framework-free on purpose. Every rule that decides whether BOE gets
// billed — how many images may be queued, which one is sent next, whether a
// retry is allowed — lives here where it can be tested without a browser and
// without a provider.
//
// The queue holds at most five images because five is what the brief allows and
// because each one is a separate paid generation: a queue that quietly accepted
// twenty would be a bill nobody agreed to.

import { validateSourceImage, type SourceImageCandidate } from './validation'

export const MAX_QUEUE_SIZE = 5

export type QueueStatus =
  /** Selected and valid, waiting its turn. Nothing has been sent. */
  | 'waiting'
  /** This one is with the provider right now. */
  | 'processing'
  /** Generated. The result is on the item. */
  | 'done'
  /** Sent and refused, or never sent because the file was rejected. */
  | 'failed'

export type QueueItem = {
  /** Stable within a session; used as a React key and to address one item. */
  id: string
  file: File
  name: string
  size: number
  status: QueueStatus
  /** Object URL of the source, for the thumbnail and the comparison. */
  previewUrl: string
  /** Why it failed, in words an employee can act on. */
  error?: string
  /**
   * True when pressing Retry would fail the same way and cost another request.
   *
   * A product too small in the frame, a photograph nothing can be separated
   * out of, a key an administrator has to fix: none of these change between one
   * press and the next, so the card offers a different photograph instead of a
   * retry. This is the difference between a failure worth another request and
   * one that is not.
   */
  noRetry?: boolean
  result?: { dataUrl: string; mimeType: string }
}

export type RejectedFile = { name: string; reason: string }

export type AddResult = {
  items: QueueItem[]
  rejected: RejectedFile[]
}

/** A File plus the fields the validator reads. Declared structurally so tests
 *  need no DOM. */
type FileLike = SourceImageCandidate & { name: string; size: number }

/** Identity for the duplicate check: the same picture chosen twice in one
 *  session is far more likely to be a slip than an intention, and each copy
 *  would be separately billed. */
function fingerprint(file: FileLike & { lastModified?: number }): string {
  return `${file.name}:${file.size}:${file.lastModified ?? 0}`
}

/**
 * Add files to the queue, keeping every good one.
 *
 * The rule that matters: ONE BAD FILE NEVER COSTS A GOOD ONE. A rejected file
 * is reported by name and dropped; everything else is queued. The same applies
 * to the five-image ceiling — the first five are kept and the rest are named,
 * rather than the whole selection being refused.
 */
export function addFilesToQueue(
  existing: QueueItem[],
  files: readonly File[],
  makePreviewUrl: (file: File) => string,
  makeId: (file: File, index: number) => string,
): AddResult {
  const items = [...existing]
  const rejected: RejectedFile[] = []
  const seen = new Set(items.map(item => fingerprint(item.file as unknown as FileLike)))

  files.forEach((file, index) => {
    if (items.length >= MAX_QUEUE_SIZE) {
      rejected.push({
        name: file.name,
        reason: `Only ${MAX_QUEUE_SIZE} images can be prepared at a time.`,
      })
      return
    }

    const key = fingerprint(file as unknown as FileLike)
    if (seen.has(key)) {
      rejected.push({ name: file.name, reason: 'That image is already in the list.' })
      return
    }

    const validation = validateSourceImage(file)
    if (!validation.ok) {
      rejected.push({ name: file.name, reason: validation.error })
      return
    }

    seen.add(key)
    items.push({
      id: makeId(file, index),
      file,
      name: file.name,
      size: file.size,
      status: 'waiting',
      previewUrl: makePreviewUrl(file),
    })
  })

  return { items, rejected }
}

/** How many generations pressing Generate would pay for, right now. */
export function pendingGenerationCount(items: QueueItem[]): number {
  return items.filter(item => item.status === 'waiting').length
}

/** The next item to send, or null when the queue is finished. */
export function nextWaiting(items: QueueItem[]): QueueItem | null {
  return items.find(item => item.status === 'waiting') ?? null
}

export type QueueCounts = {
  total: number
  waiting: number
  processing: number
  done: number
  failed: number
  /** Position of the item being worked on, for "Processing 2 of 4". */
  position: number
}

export function queueCounts(items: QueueItem[]): QueueCounts {
  const counts: QueueCounts = {
    total: items.length, waiting: 0, processing: 0, done: 0, failed: 0, position: 0,
  }
  for (const item of items) {
    if (item.status === 'waiting') counts.waiting++
    else if (item.status === 'processing') counts.processing++
    else if (item.status === 'done') counts.done++
    else counts.failed++
  }
  // Everything already dealt with, plus the one in hand.
  counts.position = counts.done + counts.failed + counts.processing
  return counts
}

/** Replace one item, leaving every other item — and every finished result —
 *  exactly as it was. This is what stops a late failure from disturbing images
 *  that already succeeded. */
export function updateItem(
  items: QueueItem[],
  id: string,
  change: Partial<QueueItem>,
): QueueItem[] {
  return items.map(item => (item.id === id ? { ...item, ...change } : item))
}

export function removeItem(items: QueueItem[], id: string): QueueItem[] {
  return items.filter(item => item.id !== id)
}

/** Items with a result, in queue order. */
export function completedItems(items: QueueItem[]): QueueItem[] {
  return items.filter(item => item.status === 'done' && item.result)
}

/** Whether a run may start: something to do, and nothing already in flight. */
export function canStartRun(items: QueueItem[]): boolean {
  const counts = queueCounts(items)
  return counts.waiting > 0 && counts.processing === 0
}

/**
 * A download name derived from the source name.
 *
 * Everything that is not a letter, digit or underscore becomes a hyphen, which
 * takes path separators and leading dots with it: a browser download is saved
 * by this name, and neither `../` nor a leading dot belongs in one.
 */
export function resultFileName(name: string, extension: string): string {
  const stem = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${stem || 'product'}-studio.${extension}`
}
