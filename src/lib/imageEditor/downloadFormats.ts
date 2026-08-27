// Which formats a finished studio image may be downloaded as.
//
// Deliberately separate from imageFormats.ts, which does the encoding: that
// module imports sharp, a native module, and a page that imported it to learn
// the NAME of a format would drag node:child_process into the browser bundle.
// The names and the guard are shared; the encoder is server-only.

export const DOWNLOAD_FORMATS = ['png', 'jpg', 'webp'] as const

export type DownloadFormat = typeof DOWNLOAD_FORMATS[number]

/** True for a value that names a format BOE will produce. An allowlist, because
 *  the value reaches a sharp encoder on the server. */
export function isDownloadFormat(value: unknown): value is DownloadFormat {
  return (DOWNLOAD_FORMATS as readonly string[]).includes(value as string)
}
