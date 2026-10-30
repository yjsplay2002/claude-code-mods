// Pure cost model for cache-meter. No `$`, so it is easy to test.
//
// Every cost is in "input-token equivalents": tokens priced at the model's
// base input rate. Anthropic's multipliers on that base:
//   cache read 0.1x · cache write 1.25x (5m TTL) / 2x (1h TTL) · output 5x
// Rate-limit windows on a subscription are drawn down in proportion to the
// same weights, so the figure works for API dollars and plan quota alike.

import type { MainStep, Ttl } from '../types'

export const READ = 0.1
export const OUTPUT = 5
export const WRITE: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
/** How close to expiry an idle cache counts as "about to go cold". */
export const EXPIRING_MS: Record<Ttl, number> = { '5m': 75_000, '1h': 8 * 60_000 }

export type AdviceKind = 'active' | 'expiring' | 'cold'

export type Params = {
  /** Turns you expect to keep working in this conversation. */
  horizonTurns: number
  /** Below this context size compaction is never suggested. */
  minContextTokens: number
  /** Below this saving (input-token equivalents) compaction is not suggested. */
  minSavingTokens: number
  /** Summary length as a share of the conversation part of the context. */
  summaryRatio: number
}

export type Advice = {
  kind: AdviceKind
  /** What the next request re-sends: the last main step's whole window. */
  contextTokens: number
  /** System prompt, tools and memory: what compaction cannot shrink. */
  baselineTokens: number
  /** Estimated summary the compaction writes. */
  summaryTokens: number
  /** Estimated context right after compaction. */
  afterTokens: number
  /** Cost over the horizon if you keep the conversation as it is. */
  keepCost: number
  /** Cost over the horizon if you compact now. */
  compactCost: number
  /** keepCost - compactCost. */
  saving: number
  /** Turns until compaction pays for itself; undefined when it never does. */
  breakEvenTurns?: number
  /** Whether the saving clears both thresholds. */
  isRecommended: boolean
}

export const contextOf = (step: MainStep): number =>
  step.input + step.cacheRead + step.cacheWrite + step.output

export const remainingMs = (step: MainStep, ttl: Ttl, now: number): number =>
  step.at + TTL_MS[ttl] - now

export function estimateSummary(conversation: number, ratio: number): number {
  return Math.round(Math.min(40_000, Math.max(3_000, conversation * ratio)))
}

/**
 * Compares keeping the conversation against compacting it now.
 *
 * `isIdle` says no turn is running and nothing was typed lately: only then can
 * an expiring cache be expected to lapse before the next message.
 */
export function advise(args: {
  step: MainStep
  baseline: number
  ttl: Ttl
  now: number
  isIdle: boolean
  params: Params
}): Advice {
  const { step, ttl, now, isIdle, params } = args
  const H = Math.max(1, Math.round(params.horizonTurns))
  const W = WRITE[ttl]
  const C = contextOf(step)
  const B = Math.min(Math.max(0, args.baseline), C)
  const M = Math.max(0, C - B)
  const S = Math.min(M, estimateSummary(M, params.summaryRatio))
  const after = B + S

  const left = remainingMs(step, ttl, now)
  const kind: AdviceKind =
    left <= 0 ? 'cold' : isIdle && left <= EXPIRING_MS[ttl] ? 'expiring' : 'active'

  // The system prompt and tools are shared by many sessions and usually stay
  // cached; the conversation part is what lapses with this session's entry.
  const rewriteAll = W * M + READ * B
  // After a compaction the next request writes the summary and reads the rest.
  const firstAfter = READ * B + W * S
  const restAfter = (H - 1) * READ * after

  let keepCost: number
  let compactCost: number
  if (kind === 'active') {
    keepCost = H * READ * C
    compactCost = READ * C + OUTPUT * S + firstAfter + restAfter
  } else if (kind === 'expiring') {
    // Kept: the next message, after expiry, writes the whole conversation.
    keepCost = rewriteAll + (H - 1) * READ * C
    // Compacted now: the summarizer still reads the warm prefix.
    compactCost = READ * C + OUTPUT * S + firstAfter + restAfter
  } else {
    // Cold either way: the summarizer itself must re-send the conversation.
    keepCost = rewriteAll + (H - 1) * READ * C
    compactCost = rewriteAll + OUTPUT * S + firstAfter + restAfter
  }

  const saving = keepCost - compactCost
  const perTurn = READ * (C - after)
  // Solving N·READ·C = oneOff + N·READ·after for the active case.
  const oneOff = compactCost - restAfter - READ * after
  const breakEvenTurns =
    kind === 'active' && perTurn > 0 ? Math.max(1, Math.ceil(oneOff / perTurn)) : undefined

  return {
    kind,
    contextTokens: C,
    baselineTokens: B,
    summaryTokens: S,
    afterTokens: after,
    keepCost: Math.round(keepCost),
    compactCost: Math.round(compactCost),
    saving: Math.round(saving),
    breakEvenTurns,
    isRecommended:
      C >= params.minContextTokens && saving >= params.minSavingTokens && M > S * 2,
  }
}

/**
 * Which TTL the main conversation's cache lives on. A setting wins; then what
 * the session observed; else Claude Code's default: one hour on a subscription
 * within its included usage, five minutes otherwise.
 */
export function resolveTtl(args: {
  setting: string
  observed: Ttl | null
  limits: readonly { percentUsed: number }[]
}): { ttl: Ttl; source: 'setting' | 'observed' | 'plan' | 'default' } {
  if (args.setting === '5m' || args.setting === '1h') {
    return { ttl: args.setting, source: 'setting' }
  }
  if (args.observed) return { ttl: args.observed, source: 'observed' }
  if (args.limits.length > 0) {
    const isOver = args.limits.some(l => l.percentUsed >= 100)
    return { ttl: isOver ? '5m' : '1h', source: 'plan' }
  }
  return { ttl: '5m', source: 'default' }
}

/**
 * Reads the TTL off a request that came after a gap longer than five minutes
 * and shorter than an hour: a cache that still served the prefix lives an
 * hour; one that had to be written again lives five minutes.
 */
export function observeTtl(prev: MainStep, next: MainStep): Ttl | null {
  const gap = next.at - prev.at
  if (gap < 5.5 * 60_000 || gap > 58 * 60_000) return null
  const prefix = contextOf(prev)
  if (prefix < 4_000) return null
  if (next.cacheRead >= prefix * 0.5) return '1h'
  if (next.cacheWrite >= prefix * 0.5) return '5m'
  return null
}

export function fmtTokens(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`
  if (a >= 10_000) return `${sign}${Math.round(a / 1000)}k`
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(1)}k`
  return `${sign}${Math.round(a)}`
}

/** Ten cells, at least one lit once anything is used. */
export function gauge(share: number): string {
  const lit = share > 0 ? Math.min(10, Math.max(1, Math.round(share * 10))) : 0
  return '█'.repeat(lit) + '░'.repeat(10 - lit)
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export function fmtUsd(tokens: number, usdPerMTok: number): string | undefined {
  if (!(usdPerMTok > 0)) return undefined
  const usd = (tokens / 1_000_000) * usdPerMTok
  return `$${usd < 1 ? usd.toFixed(2) : usd.toFixed(1)}`
}
