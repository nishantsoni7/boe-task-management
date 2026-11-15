import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { answerJson, closedSchema, jsonFormat } from './structuredOutput'

describe('structured output', () => {
  test('every object in the schema is closed, nested ones too; the original is not changed', () => {
    const s = { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'object', properties: {} } } } } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking a JSON schema
    const c = closedSchema(s) as any
    assert.equal(c.additionalProperties, false)
    assert.equal(c.properties.a.items.additionalProperties, false)
    assert.equal(c.properties.a.items.properties.b.additionalProperties, false)
    assert.equal('additionalProperties' in s, false)
    assert.deepEqual(jsonFormat(s).type, 'json_schema')
  })

  test('the answer is the JSON text; cut short, declined or not JSON gives nothing', () => {
    assert.deepEqual(answerJson({ content: [{ type: 'thinking' }, { type: 'text', text: '{"verdict":' }, { type: 'text', text: '"lead"}' }], stop_reason: 'end_turn' }), { verdict: 'lead' })
    assert.equal(answerJson({ content: [{ type: 'text', text: '{"verdict":"le' }], stop_reason: 'max_tokens' }), undefined)
    assert.equal(answerJson({ content: [{ type: 'text', text: '{}' }], stop_reason: 'refusal' }), undefined)
    assert.equal(answerJson({ content: [{ type: 'text', text: 'It is a lead' }] }), undefined)
    assert.equal(answerJson(null), undefined)
  })

  test('no Claude call in the app forces a tool any more (Sonnet 5.5 and Opus 5.5 answer it with a 400)', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    const forcing = files.filter(f => /tool_choice:\s*\{\s*type:\s*'(tool|any)'/.test(readFileSync(f, 'utf8')))
    assert.deepEqual(forcing, [])
  })
})
