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
