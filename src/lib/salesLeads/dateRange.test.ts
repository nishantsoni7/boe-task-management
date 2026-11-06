/**
 * Sales, Lead Master: the days a list is cut to, and the words that say so.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/dateRange.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { hasDays, leadWhen, monthDays, monthOf, NO_DAYS, orderDays, rangeLabel, whenWords } from './dateRange'

const TODAY = '2026-11-06'

describe('what the list asks the database for', () => {
  test('a card is a period and no days', () => {
    assert.deepEqual(leadWhen('week', NO_DAYS, TODAY, false), { period: 'week', from: '', to: '' })
    assert.deepEqual(leadWhen('today', NO_DAYS, TODAY, false), { period: 'today', from: '', to: '' })
  })
  test('Yesterday is sent as the day itself, never as the word alone', () => {
    assert.deepEqual(leadWhen('yesterday', NO_DAYS, TODAY, false), { period: 'yesterday', from: '2026-11-05', to: '2026-11-05' })
    // across a month and a year
    assert.deepEqual(leadWhen('yesterday', NO_DAYS, '2026-01-01', false), { period: 'yesterday', from: '2025-12-31', to: '2025-12-31' })
  })
  test('chosen days win over a card', () => {
    const w = leadWhen('today', { from: '2026-11-01', to: '2026-11-05' }, TODAY, false)
    assert.deepEqual(w, { period: 'all', from: '2026-11-01', to: '2026-11-05' })
  })
  test('one side alone is open on the other', () => {
    assert.deepEqual(leadWhen('today', { from: '2026-11-01', to: '' }, TODAY, false), { period: 'all', from: '2026-11-01', to: '' })
    assert.deepEqual(leadWhen('today', { from: '', to: '2026-11-05' }, TODAY, false), { period: 'all', from: '', to: '2026-11-05' })
  })
  test('a pair typed the wrong way round is the range between the two', () => {
    assert.deepEqual(orderDays({ from: '2026-11-05', to: '2026-11-01' }), { from: '2026-11-01', to: '2026-11-05' })
    assert.deepEqual(leadWhen('today', { from: '2026-11-05', to: '2026-11-01' }, TODAY, false), { period: 'all', from: '2026-11-01', to: '2026-11-05' })
    assert.deepEqual(orderDays({ from: '2026-11-05', to: '' }), { from: '2026-11-05', to: '' })
  })
  test('a search looks through every day, whatever card or days are set', () => {
    assert.deepEqual(leadWhen('yesterday', { from: '2026-11-01', to: '2026-11-05' }, TODAY, true), { period: 'all', from: '', to: '' })
  })
  test('hasDays', () => {
    assert.equal(hasDays(NO_DAYS), false)
    assert.equal(hasDays({ from: '2026-11-01', to: '' }), true)
    assert.equal(hasDays({ from: '', to: '2026-11-01' }), true)
  })
})

describe('the months', () => {
  test('this month runs to today, last month is the whole of it', () => {
    assert.deepEqual(monthDays('this', TODAY), { from: '2026-11-01', to: '2026-11-06' })
    assert.deepEqual(monthDays('last', TODAY), { from: '2026-10-01', to: '2026-10-31' })
  })
  test('last month across a year and in a leap February', () => {
    assert.deepEqual(monthDays('last', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' })
    assert.deepEqual(monthDays('last', '2028-03-02'), { from: '2028-02-01', to: '2028-02-29' })
  })
  test('the first of the month: this month is that one day', () => {
    assert.deepEqual(monthDays('this', '2026-11-01'), { from: '2026-11-01', to: '2026-11-01' })
  })
  test('days that are exactly a month read as that month', () => {
    assert.equal(monthOf({ from: '2026-11-01', to: '2026-11-06' }, TODAY), 'this')
    assert.equal(monthOf({ from: '2026-10-01', to: '2026-10-31' }, TODAY), 'last')
    assert.equal(monthOf({ from: '2026-10-01', to: '2026-10-30' }, TODAY), null)
    assert.equal(monthOf(NO_DAYS, TODAY), null)
  })
})

describe('the words', () => {
  test('the dates button says what is chosen', () => {
    assert.equal(rangeLabel(NO_DAYS, TODAY), 'Custom dates')
    assert.equal(rangeLabel({ from: '2026-11-01', to: '2026-11-05' }, TODAY), '1 Nov – 5 Nov 2026')
    assert.equal(rangeLabel({ from: '2026-11-03', to: '2026-11-03' }, TODAY), '3 Nov 2026')
    assert.equal(rangeLabel({ from: '2025-12-28', to: '2026-01-03' }, TODAY), '28 Dec 2025 – 3 Jan 2026')
    assert.equal(rangeLabel({ from: '2026-11-01', to: '' }, TODAY), 'From 1 Nov 2026')
    assert.equal(rangeLabel({ from: '', to: '2026-11-05' }, TODAY), 'Until 5 Nov 2026')
  })
  test('a whole month reads as This month or Last month', () => {
    assert.equal(rangeLabel(monthDays('this', TODAY), TODAY), 'This month')
    assert.equal(rangeLabel(monthDays('last', TODAY), TODAY), 'Last month')
  })
  test('the footer finishes "received ..."', () => {
    assert.equal(whenWords(leadWhen('today', NO_DAYS, TODAY, false)), 'today')
    assert.equal(whenWords(leadWhen('yesterday', NO_DAYS, TODAY, false)), 'yesterday')
    assert.equal(whenWords(leadWhen('week', NO_DAYS, TODAY, false)), 'in the last 7 days')
    assert.equal(whenWords(leadWhen('month', NO_DAYS, TODAY, false)), 'in the last 30 days')
    assert.equal(whenWords(leadWhen('all', NO_DAYS, TODAY, false)), 'so far')
    assert.equal(whenWords(leadWhen('all', { from: '2026-11-01', to: '2026-11-05' }, TODAY, false)), 'between 1 Nov and 5 Nov 2026')
    assert.equal(whenWords(leadWhen('all', { from: '2026-11-03', to: '2026-11-03' }, TODAY, false)), 'on 3 Nov 2026')
    assert.equal(whenWords(leadWhen('all', { from: '2026-11-01', to: '' }, TODAY, false)), 'from 1 Nov 2026')
    assert.equal(whenWords(leadWhen('all', { from: '', to: '2026-11-05' }, TODAY, false)), 'up to 5 Nov 2026')
  })
})
