// Shared attachment helpers — usable in both server and client contexts.
// compressImageFile() is client-only (uses canvas + URL.createObjectURL).

export const IMAGE_EXTS    = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const
export const COMPRESS_EXTS = ['jpg', 'jpeg', 'webp'] as const // lossy-safe; skip png (transparency) and gif (animated)

export function getExt(urlOrName: string): string {
  try {
    const pathname = new URL(urlOrName).pathname
    return pathname.split('.').pop()?.toLowerCase() ?? ''
  } catch {
    return urlOrName.split('.').pop()?.toLowerCase() ?? ''
  }
}

export function getFileTypeLabel(urlOrName: string): string {
  const ext = getExt(urlOrName)
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'Image'
  if (ext === 'pdf')                                         return 'PDF'
  if (['xlsx', 'xls'].includes(ext))                        return 'Excel'
  if (['docx', 'doc'].includes(ext))                        return 'Word'
  if (ext === 'csv')                                         return 'CSV'
  if (['zip', 'rar', '7z'].includes(ext))                   return 'Archive'
  return 'File'
}

export const ACCEPTED_ATTACHMENT_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
] as const

// Browsers sometimes leave `file.type` blank (e.g. some CSV/text sources on Windows) — fall back to extension.
export function isAcceptedAttachmentType(file: File): boolean {
  if ((ACCEPTED_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return true
  if (file.type) return false
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'].includes(getExt(file.name))
}

// Splits files into accepted/rejected by MIME type. Used by browse, drag-and-drop, and paste
// so the same validation applies no matter how a file enters the upload flow.
export function filterAcceptedFiles(files: File[]): { accepted: File[]; rejectedNames: string[] } {
  const accepted: File[] = []
  const rejectedNames: string[] = []
  for (const f of files) {
    if (isAcceptedAttachmentType(f)) accepted.push(f)
    else rejectedNames.push(f.name)
  }
  return { accepted, rejectedNames }
}

const SIZE_LIMIT = 10 * 1024 * 1024 // 10 MB

// Compress all eligible files then validate total size ≤ 10 MB.
// Returns compressed files on success, or an error string to display.
export async function prepareFiles(
  files: File[],
): Promise<{ ready: File[]; error: string | null }> {
  const ready = await Promise.all(files.map(f => compressImageFile(f)))
  const total = ready.reduce((sum, f) => sum + f.size, 0)
  if (total > SIZE_LIMIT) {
    return {
      ready: [],
      error: 'Total attachment size must be under 10 MB. Please remove or reduce files.',
    }
  }
  return { ready, error: null }
}

// Compress a JPEG/WEBP image client-side via canvas.
// Returns the original file unchanged when:
//   - the file type is not compressible (PNG, GIF, PDF, etc.)
//   - the compressed result would be larger than the original
//   - the browser canvas API is unavailable
export async function compressImageFile(file: File, quality = 0.78): Promise<File> {
  const compressibleTypes = ['image/jpeg', 'image/jpg', 'image/webp']
  if (!compressibleTypes.includes(file.type)) return file
  if (typeof window === 'undefined') return file

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const canvas = document.createElement('canvas')
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(file); return }
      ctx.drawImage(img, 0, 0)
      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) { resolve(file); return }
          resolve(new File([blob], file.name, { type: file.type, lastModified: Date.now() }))
        },
        file.type,
        quality,
      )
    }

    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
    img.src = objectUrl
  })
}
