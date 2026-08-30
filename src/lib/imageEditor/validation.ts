// What counts as an uploadable furniture photograph.
//
// One module, used by BOTH halves of the flow: the browser refuses a bad file
// before it costs an upload, and the route refuses it again before it costs a
// provider call. A client-side check is a courtesy, never a control — anyone can
// POST to the route directly — so the same function decides in both places and
// the two cannot drift into disagreeing about what "a JPG" means.

export const STUDIO_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type StudioImageMimeType = typeof STUDIO_IMAGE_MIME_TYPES[number]

/** `accept` for the file input. Extensions as well as MIME types: some Android
 *  pickers match only on extension, and some desktop browsers only on type. */
export const STUDIO_IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'

/** 10 MB, the same ceiling the task-attachment flow uses. A phone photograph is
 *  2–6 MB; anything past this is a scan or a RAW export, and the provider
 *  request has its own size limit further down. */
export const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_SOURCE_IMAGE_LABEL = '10 MB'

/** The shape both a browser `File` and a server-side `File` from `formData()`
 *  satisfy. Declared structurally so this module needs no DOM lib and no Node
 *  types, and so a test can pass a plain object. */
export type SourceImageCandidate = {
  name?: string
  type?: string
  size?: number
}

export type SourceImageValidation =
  | { ok: true; mimeType: StudioImageMimeType }
  | { ok: false; error: string }

const EXTENSION_TYPES: Record<string, StudioImageMimeType> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
}

const WRONG_FORMAT = 'That file type is not supported. Upload a JPG, PNG or WebP photograph.'

/** The MIME type implied by a file name, or null. Browsers leave `File.type`
 *  blank often enough — some Windows sources, some camera apps — that a name
 *  fallback is the difference between "works" and "works on my machine". */
export function mimeTypeFromName(name: string | undefined): StudioImageMimeType | null {
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_TYPES[ext] ?? null
}

/**
 * Decide whether this file may be sent for editing, and under which MIME type.
 *
 * The returned `mimeType` is what the provider is told, and it is derived here
 * rather than taken from the upload: a file called `chair.png` that the browser
 * reported as `image/jpeg` is sent as `image/jpeg`, because that is what the
 * bytes are most likely to be.
 */
export function validateSourceImage(
  file: SourceImageCandidate | null | undefined,
): SourceImageValidation {
  if (!file) return { ok: false, error: 'Choose a photograph to upload.' }

  const declared = (file.type ?? '').toLowerCase().trim()
  const fromName = mimeTypeFromName(file.name)

  const mimeType: StudioImageMimeType | null =
    (STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(declared)
      ? declared as StudioImageMimeType
      : declared
        // A type was declared and it is not one we accept. `image/heic` from an
        // iPhone lands here, and saying so beats a silent failure later.
        ? null
        : fromName

  if (!mimeType) return { ok: false, error: WRONG_FORMAT }

  const size = file.size ?? 0
  if (size <= 0) return { ok: false, error: 'That file is empty. Choose another photograph.' }
  if (size > MAX_SOURCE_IMAGE_BYTES) {
    return {
      ok: false,
      error: `That photograph is larger than ${MAX_SOURCE_IMAGE_LABEL}. Upload a smaller file.`,
    }
  }

  return { ok: true, mimeType }
}
