// Getting JSON that matches a schema back from Claude (15 Nov 2026).
//
// The app used to FORCE a tool call (tool_choice { type: 'tool' }) and read the tool's input. Claude Sonnet 5.5 and Opus 5.5
// refuse that with a 400 ("tool_choice: type "tool" and "any" are not supported for this model"), checked against the live
// API on 15 Nov 2026; Haiku 5.5 still accepts it. Structured output (output_config.format) is the supported way on every
// current model: the answer is a text block holding JSON that matches the schema. It needs every object in the schema closed.

type Schema = { [k: string]: unknown }

/**
 * The schema with `additionalProperties: false` on every object, as structured output requires. With `allRequired`, every
 * property is required too: a schema with many optional fields was refused as "Schema is too complex" after about 3 minutes
 * of compiling (the quotation scan, 15 Nov 2026) and accepted in seconds once all were required; the model then fills every
 * field, an empty value meaning "not there".
 */
export function closedSchema<T extends Schema>(s: T, allRequired = false): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    if (o.type !== 'object') return o
    return { ...o, additionalProperties: false, ...(allRequired && o.properties ? { required: Object.keys(o.properties as object) } : {}) }
  }
  return walk(s) as T
}

/** What goes in the request: `output_config: { format: jsonFormat(schema) }`. */
export const jsonFormat = (schema: Schema) => ({ type: 'json_schema' as const, schema: closedSchema(schema) })

type Answer = { content?: { type: string; text?: string }[]; stop_reason?: string } | null | undefined

/** The JSON the model answered, or undefined when it was cut short, declined, or is not JSON. */
export function answerJson(answer: Answer): unknown {
  if (!answer || answer.stop_reason === 'max_tokens' || answer.stop_reason === 'refusal') return undefined
  const text = (answer.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('')
  try { return JSON.parse(text) } catch { return undefined }
}
