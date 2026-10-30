import { expect, mock, test } from 'claude-code/testing'

import { advise, fmtDuration, fmtTokens, gauge, observeTtl, resolveTtl } from '../hooks/calc'
import type { MainStep } from '../types'

const NOW = 1_800_000_000_000
const params = { horizonTurns: 15, minContextTokens: 80_000, minSavingTokens: 40_000, summaryRatio: 0.08 }
// A 200k window: 30k system prompt and tools, 170k of conversation.
const step: MainStep = {
  at: NOW - 10 * 60_000,
  input: 2_000,
  cacheRead: 190_000,
  cacheWrite: 6_000,
  output: 2_000,
  model: 'claude-opus-5-5',
}

test('a large warm conversation is worth compacting over 15 turns', async () => {
  const a = advise({ step, baseline: 30_000, ttl: '1h', now: NOW, isIdle: false, params })
  expect(a.kind).toBe('active')
  expect(a.contextTokens).toBe(200_000)
  expect(a.summaryTokens).toBe(13_600)
  // keep: 15 × 0.1 × 200k
  expect(a.keepCost).toBe(300_000)
  expect(a.saving).toBeGreaterThan(40_000)
  expect(a.isRecommended).toBe(true)
  expect(a.breakEvenTurns).toBeGreaterThan(1)
})

test('a small conversation is never suggested', async () => {
  const small = { ...step, cacheRead: 40_000 }
  const a = advise({ step: small, baseline: 30_000, ttl: '1h', now: NOW, isIdle: false, params })
  expect(a.isRecommended).toBe(false)
})

test('an idle cache near expiry counts the rewrite it avoids', async () => {
  const near = { ...step, at: NOW - 55 * 60_000 }
  const a = advise({ step: near, baseline: 30_000, ttl: '1h', now: NOW, isIdle: true, params })
  expect(a.kind).toBe('expiring')
  const busy = advise({ step: near, baseline: 30_000, ttl: '1h', now: NOW, isIdle: false, params })
  expect(busy.kind).toBe('active')
  expect(a.saving).toBeGreaterThan(busy.saving)
})

test('a lapsed cache is cold', async () => {
  const old = { ...step, at: NOW - 61 * 60_000 }
  expect(advise({ step: old, baseline: 30_000, ttl: '1h', now: NOW, isIdle: true, params }).kind).toBe('cold')
})

test('the TTL is read off the plan, a setting, or what the cache did', async () => {
  expect(resolveTtl({ setting: 'auto', observed: null, limits: [] }).ttl).toBe('5m')
  expect(resolveTtl({ setting: 'auto', observed: null, limits: [{ percentUsed: 20 }] }).ttl).toBe('1h')
  expect(resolveTtl({ setting: 'auto', observed: null, limits: [{ percentUsed: 100 }] }).ttl).toBe('5m')
  expect(resolveTtl({ setting: '5m', observed: '1h', limits: [{ percentUsed: 1 }] }).ttl).toBe('5m')
  const later = { ...step, at: step.at + 20 * 60_000 }
  expect(observeTtl(step, later)).toBe('1h')
  expect(observeTtl(step, { ...later, cacheRead: 0, cacheWrite: 195_000 })).toBe('5m')
  expect(observeTtl(step, { ...step, at: step.at + 60_000 })).toBe(null)
})

test('numbers read short', async () => {
  expect(fmtTokens(214_000)).toBe('214k')
  expect(fmtTokens(1_000_000)).toBe('1.0M')
  expect(fmtDuration(42 * 60_000)).toBe('42m')
  expect(fmtDuration(130 * 60_000)).toBe('2h10m')
  expect(gauge(0)).toBe('░░░░░░░░░░')
  expect(gauge(0.01)).toBe('█░░░░░░░░░')
  expect(gauge(0.21)).toBe('██░░░░░░░░')
  expect(gauge(1.3)).toBe('██████████')
})

const BAND = {
  plugin: 'cache-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const SEEDED: Record<string, unknown> = {
  last: { shape: 'step-1', value: { ...step, at: NOW - 10 * 60_000 } },
  baseline: 30_000,
  limits: {
    shape: 'limits-1',
    value: [{ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 130 * 60_000).toISOString() }],
  },
  window: 1_000_000,
}

function seed(on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.clock(on, { now: NOW })
  on('state.get', (_, e) => {
    const value = SEEDED[e.key]
    return { value: value === undefined ? { value: undefined, version: 0 } : { value, version: 1 } }
  })
}

test('the band only offers the compact button', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /left \(|남음/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the status line carries session cache state, not usage limits', async ($, on) => {
  mock.clock(on, { now: NOW })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      rateLimits: [{ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 130 * 60_000).toISOString() }],
      context: { window: 1_000_000 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(lines.at(-1)).toBe('○ cache: waiting for the first reply  │  Auto Compact Mode: Idle')
})

test('the status line says a compaction happened while the cache waits for a reply', async ($, on) => {
  mock.clock(on, { now: NOW })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('state.get', (_, e) =>
    e.key === 'compacted'
      ? { value: { value: { shape: 'compacted-1', value: { at: NOW - 7 * 60_000, trigger: 'plugin' } }, version: 1 } }
      : { value: { value: undefined, version: 0 } },
  )
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 1_000_000 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(lines.at(-1)).toBe('◇ compacted (cache-meter, 7m ago) · waiting for the first reply  │  Auto Compact Mode: Idle')
})
