// One fetch helper for the Draft Orders (ClickUp) pages: the routes answer
// { error, message } on a refusal, and the message is already in plain words.

export async function callDrafts<T>(
  url: string,
  body?: unknown,
): Promise<{ ok: true; body: T } | { ok: false; message: string; code?: string }> {
  try {
    const res = await fetch(url, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({})) as { message?: string; error?: string }
    if (!res.ok) return { ok: false, message: json.message ?? 'Something went wrong. Please try again.', code: json.error }
    return { ok: true, body: json as T }
  } catch {
    return { ok: false, message: 'Check your connection and try again.' }
  }
}
