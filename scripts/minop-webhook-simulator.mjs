#!/usr/bin/env node

/**
 * Stage-1 Minop webhook simulator.
 *
 * This deliberately knows NOTHING about Minop's payload schema. Give it the
 * exact JSON fixture/body you want BOE to capture; it only sends the HTTP
 * request using BOE's receiving contract.
 *
 * PowerShell example:
 *   $env:MINOP_WEBHOOK_URL='http://localhost:3000/api/integrations/minop/webhook'
 *   $env:MINOP_WEBHOOK_SECRET='dev-only-secret'
 *   node scripts/minop-webhook-simulator.mjs .\tmp\real-minop-payload.json
 */

import { readFile } from 'node:fs/promises'

const [fixturePath] = process.argv.slice(2)
const url = process.env.MINOP_WEBHOOK_URL
const secret = process.env.MINOP_WEBHOOK_SECRET

if (!fixturePath || !url || !secret) {
  console.error('Usage: set MINOP_WEBHOOK_URL and MINOP_WEBHOOK_SECRET, then pass a JSON fixture path.')
  process.exitCode = 2
} else {
  const rawBody = await readFile(fixturePath, 'utf8')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'user-agent': 'boe-minop-stage1-simulator/1',
    },
    body: rawBody,
  })

  const responseText = await response.text()
  console.log(`${response.status} ${response.statusText}`)
  console.log(responseText)

  if (!response.ok) process.exitCode = 1
}
