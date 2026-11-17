// The small, always-loaded part of the splash library: the kinds, their labels
// and the length limit. The ~24 KB of lines themselves are in items.ts, which
// the BOE One loader (it lives in the root layout, so it is on EVERY page) must
// only load on demand, through a dynamic import. Keep this file free of data.

export type SplashKind = 'fact' | 'boe' | 'work' | 'oneliner' | 'jingle' | 'motivation' | 'news'

export type SplashItem = {
  kind: SplashKind
  text: string
  /** A named quote's author, or a news headline's publisher. */
  by?: string
}

export const MAX_SPLASH_CHARS = 110

export const SPLASH_LABEL: Record<SplashKind, string> = {
  fact: 'Fun fact',
  boe: 'Did you know?',
  work: 'Work hack',
  oneliner: 'One-liner',
  jingle: 'Jingle',
  motivation: 'Motivation',
  news: 'In the news',
}
