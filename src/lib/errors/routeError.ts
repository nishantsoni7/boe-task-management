// ── What a page that failed to render tells the person ──────────────────────
//
// WHY THIS EXISTS. The app had no error.tsx and no global-error.tsx, so any
// render error on any route fell through to Next's bare default screen — no way
// back but the browser's own reload, and no hint whether retrying could help.
// The /expenses `amount.trim is not a function` crash reached users that way.
//
// WHAT IT SAYS. Never the error's own message: a message thrown by app code can
// carry a customer name or an amount, and it is not the reader's to act on.
// Only a kind (so the wording can say what helps) and, for server errors, the
// digest Next attaches, which matches the server log line and identifies
// nothing about the record.
//
// NOTHING RELOADS ON ITS OWN. Every recovery is a button the person presses;
// see src/lib/navigation/tabRecovery.ts for why BOE never reloads by itself.

export type RouteErrorKind =
  /** The page's code for this deployment is gone — BOE was updated since this tab loaded. */
  | 'updated'
  /** The network dropped while loading. Retrying usually works. */
  | 'network'
  /** Anything else. */
  | 'error'

const CHUNK = /ChunkLoadError|Loading (CSS )?chunk [\w:-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed/i
const NETWORK = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i

export function classifyRouteError(error: { name?: unknown; message?: unknown } | null | undefined): RouteErrorKind {
  const name = typeof error?.name === 'string' ? error.name : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  if (name === 'ChunkLoadError' || CHUNK.test(message)) return 'updated'
  if (NETWORK.test(message.trim())) return 'network'
  return 'error'
}

export const ROUTE_ERROR_COPY: Record<RouteErrorKind, { title: string; body: string; primary: 'retry' | 'reload' }> = {
  updated: {
    title: 'BOE has been updated',
    body: 'This page needs the latest version. Reload to continue.',
    primary: 'reload',
  },
  network: {
    title: 'The connection dropped',
    body: 'The page could not finish loading. Check the connection and try again.',
    primary: 'retry',
  },
  error: {
    title: 'This page ran into a problem',
    body: 'Try again. If it keeps happening, reload the page or go back to Modules.',
    primary: 'retry',
  },
}

/** A digest as Next issues it (for server errors), or null. Never the message. */
export function safeDigest(digest: unknown): string | null {
  return typeof digest === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(digest) ? digest : null
}
