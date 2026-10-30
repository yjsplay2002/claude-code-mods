import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HitTotals, MainStep, RateLimit, Ttl } from '../types'
import {
  EXPIRING_MS,
  READ,
  WRITE,
  advise,
  contextOf,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  gauge,
  observeTtl,
  remainingMs,
  resolveTtl,
} from './calc'
import type { Advice, Params } from './calc'

const PLUGIN = 'cache-meter'
const PANE = 'cache-meter'
const TICK_MS = 10_000
/** Quiet this long (no turn, no typing) before a session counts as idle. */
const IDLE_MS = 90_000
/** The system prompt and tools rarely exceed this; caps a resumed session's guess. */
const BASELINE_CAP = 45_000
const DEFAULT_SUMMARY_RATIO = 0.08

const last = atom({ plugin: 'cache-meter', key: 'last' } as const, null, { shape: 'step-1' })
const baseline = atom({ plugin: 'cache-meter', key: 'baseline' } as const, 0)
const NO_HITS = { read: 0, write: 0, total: 0, misses: 0 }
const hits = atom({ plugin: 'cache-meter', key: 'hits' } as const, NO_HITS, { shape: 'hits-2' })
const limits = atom({ plugin: 'cache-meter', key: 'limits' } as const, [], { shape: 'limits-1' })
const windowSize = atom({ plugin: 'cache-meter', key: 'window' } as const, 0)
const ttlSeen = atom({ plugin: 'cache-meter', key: 'ttlSeen' } as const, null)
const isBusy = atom({ plugin: 'cache-meter', key: 'isBusy' } as const, false)
const isCompacting = atom({ plugin: 'cache-meter', key: 'isCompacting' } as const, false)
const tick = atom({ plugin: 'cache-meter', key: 'tick' } as const, 0)
const note = atom({ plugin: 'cache-meter', key: 'note' } as const, null)
const compacted = atom({ plugin: 'cache-meter', key: 'compacted' } as const, null, { shape: 'compacted-1' })
const isBandHidden = atom({ plugin: 'cache-meter', key: 'isBandHidden' } as const, false)

type AutoMode = 'off' | 'idle' | 'always'
const AUTO_LABEL: Record<AutoMode, string> = { off: '끔', idle: '자리 비울 때만', always: '항상' }
const NEXT_AUTO: Record<AutoMode, AutoMode> = { off: 'idle', idle: 'always', always: 'off' }
type Lang = 'en' | 'ko'
type StatusText = {
  compacting: string
  waiting: string
  compacted: (how: string, ago: string) => string
  expired: (ago: string, rewrite: string) => string
  left: (time: string, ttl: Ttl) => string
  hit: (last: string, session: string) => string
  saved: (n: string) => string
  rewrites: (n: number) => string
  auto: Record<AutoMode, string>
  how: Record<string, string>
}
const STATUS: Record<Lang, StatusText> = {
  en: {
    compacting: '◐ compacting…',
    waiting: '○ cache: waiting for the first reply',
    compacted: (how, ago) => `◇ compacted (${how}, ${ago} ago) · waiting for the first reply`,
    expired: (ago, rewrite) => `✕ cache expired (${ago} ago) · rewrite ≈${rewrite} · not compacted`,
    left: (time, ttl) => `cache ${time} left (${ttl})`,
    hit: (last, session) => `hit ${last} (session ${session})`,
    saved: n => `Cache saved ≈${n}`,
    rewrites: n => `Cache misses ${n} (context re-written)`,
    auto: { off: 'Auto Compact Mode: Off', idle: 'Auto Compact Mode: Idle', always: 'Auto Compact Mode: Always' },
    how: { manual: '/compact', auto: 'auto threshold', plugin: 'cache-meter' },
  },
  ko: {
    compacting: '◐ compact 중…',
    waiting: '○ 캐시: 첫 응답 대기',
    compacted: (how, ago) => `◇ compact됨 (${how}, ${ago} 전) · 첫 응답 대기`,
    expired: (ago, rewrite) => `✕ 캐시 만료 (${ago} 전) · 재작성 ≈${rewrite} · compact 안 됨`,
    left: (time, ttl) => `캐시 ${time} 남음 (${ttl})`,
    hit: (last, session) => `적중 ${last} (세션 ${session})`,
    saved: n => `캐시 절약 ≈${n}`,
    rewrites: n => `캐시 깨짐 ${n}회 (컨텍스트 재작성)`,
    auto: { off: '자동 compact 모드: 끔', idle: '자동 compact 모드: 자리 비울 때만', always: '자동 compact 모드: 항상' },
    how: { manual: '/compact', auto: '자동(임계치)', plugin: 'cache-meter' },
  },
}

const KIND_LABEL: Record<Advice['kind'], string> = {
  active: '작업 중',
  expiring: '곧 만료',
  cold: '만료됨',
}

type View = {
  now: number
  step: MainStep | null
  advice: Advice | null
  ttl: Ttl
  ttlSource: string
  limits: RateLimit[]
  window: number
  hits: HitTotals
  isBusy: boolean
  isCompacting: boolean
  note: string | null
  auto: AutoMode
  compacted: { at: number; trigger: string } | null
  lang: Lang
}

type Cfg = {
  auto: AutoMode
  params: (ratio: number) => Params
  horizon: number
  ttlSetting: string
  usdPerMTok: number
  lang: Lang
}

// Module variables start over on a reload; nothing here needs to survive one.
let cfg: Cfg = {
  auto: 'idle',
  params: ratio => ({ horizonTurns: 15, minContextTokens: 80_000, minSavingTokens: 40_000, summaryRatio: ratio }),
  horizon: 15,
  ttlSetting: 'auto',
  usdPerMTok: 0,
  lang: 'en',
}
let typedAt = 0
let turnEndedAt = 0
let autoDoneFor = -1
let summaryRatio = DEFAULT_SUMMARY_RATIO

async function view($: EngineInterface): Promise<View> {
  await read($, tick) // subscribes the drawing to the clock
  const now = await $.clock.now()
  const step = await read($, last)
  const lim = await read($, limits)
  const resolved = resolveTtl({ setting: cfg.ttlSetting, observed: await read($, ttlSeen), limits: lim })
  const busy = await read($, isBusy)
  const quietSince = Math.max(step?.at ?? 0, typedAt, turnEndedAt)
  const advice = step
    ? advise({
        step,
        baseline: await read($, baseline),
        ttl: resolved.ttl,
        now,
        isIdle: !busy && now - quietSince >= IDLE_MS,
        params: cfg.params(summaryRatio),
      })
    : null
  return {
    now,
    step,
    advice,
    ttl: resolved.ttl,
    ttlSource: resolved.source,
    limits: lim,
    window: await read($, windowSize),
    hits: await read($, hits),
    isBusy: busy,
    isCompacting: await read($, isCompacting),
    note: await read($, note),
    auto: cfg.auto,
    compacted: await read($, compacted),
    lang: cfg.lang,
  }
}

async function refreshStatus($: EngineInterface): Promise<void> {
  $.ui.status((await read($, isBandHidden)) ? undefined : statusLine(await view($)))
}

async function compactNow($: EngineInterface, why: string): Promise<void> {
  if (await read($, isBusy)) {
    $.ui.toast('cache-meter: 턴이 실행 중이라 compact할 수 없어요. 응답이 끝난 뒤 다시 눌러주세요.')
    return
  }
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  await refreshStatus($)
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) $.ui.toast(`cache-meter: compact 건너뜀 (${result.skip})`)
    else if (why !== 'button') $.ui.toast(`cache-meter: ${why} — 자동 compact 했어요`)
  } catch (err) {
    $.ui.toast(`cache-meter: compact 실패 — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, isCompacting, () => false)
  }
}

async function setAuto($: EngineInterface, mode: AutoMode): Promise<string> {
  const row = (await $.config.list()).find(
    r => r.key.startsWith(PLUGIN) && r.key.endsWith('.autoCompact'),
  )
  if (!row) return '설정 항목을 찾지 못했어요. /config 에서 cache-meter 의 Auto compact 를 바꿔주세요.'
  const set = await $.config.set({ key: row.key, value: mode })
  if ('deny' in set && set.deny) return `바꾸지 못했어요: ${set.deny}`
  return `자동 compact: ${AUTO_LABEL[mode]}`
}

async function autoCheck($: EngineInterface): Promise<void> {
  if (cfg.auto === 'off') return
  const v = await view($)
  const a = v.advice
  if (!a || !a.isRecommended || v.isBusy || v.isCompacting || !v.step) return
  if (autoDoneFor === v.step.at) return
  const isIdle = v.now - Math.max(v.step.at, typedAt, turnEndedAt) >= IDLE_MS
  const isDue =
    a.kind === 'expiring' || (cfg.auto === 'always' && a.kind === 'active' && isIdle)
  if (!isDue) return
  autoDoneFor = v.step.at
  await compactNow(
    $,
    a.kind === 'expiring' ? `캐시 만료 ${fmtDuration(remainingMs(v.step, v.ttl, v.now))} 전` : '비용 우위',
  )
}

export const register: Register = (on, options) => {
  const horizon = num(options.horizonTurns, 15)
  cfg = {
    auto:
      options.autoCompact === 'off' || options.autoCompact === 'always' ? options.autoCompact : 'idle',
    params: ratio => ({
      horizonTurns: horizon,
      minContextTokens: num(options.minContextTokens, 80_000),
      minSavingTokens: num(options.minSavingTokens, 40_000),
      summaryRatio: ratio,
    }),
    horizon,
    ttlSetting: typeof options.ttl === 'string' ? options.ttl : 'auto',
    usdPerMTok: num(options.inputUsdPerMTok, 0),
    lang: options.language === 'ko' ? 'ko' : 'en',
  }
  const { auto, usdPerMTok } = cfg

  on('session.start', async ($, e, next) => {
    const stored = Number(await $.store.get('summaryRatio'))
    if (stored > 0 && stored < 1) summaryRatio = stored
    await $.command.register({
      name: 'cache-meter',
      description: 'Prompt cache use in this session and compact advice. Args: auto off|idle|always, band',
      argumentHint: '[auto off|idle|always | band]',
    })
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits.map(toLimit))
    await update($, windowSize, () => usage.context.window)
    $.clock.every(TICK_MS, () => {
      void update($, tick, n => n + 1)
        .then(() => refreshStatus($))
        .then(() => autoCheck($))
    })
    await refreshStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, last, () => null)
      await update($, baseline, () => 0)
      await update($, hits, () => NO_HITS)
      await update($, note, () => null)
      await update($, compacted, () => null)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => e.rateLimits.map(toLimit))
    await update($, windowSize, () => e.context.window)
    return next(e)
  })

  on('prompt.change', async ($, e, next) => {
    typedAt = await $.clock.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnEndedAt = await $.clock.now()
      await update($, isBusy, () => false)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId === undefined && u) {
      const step: MainStep = {
        at: await $.clock.now(),
        input: u.input_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        output: u.output_tokens,
        model: u.model,
      }
      const prev = await read($, last)
      const seen = prev ? observeTtl(prev, step) : null
      if (seen) await update($, ttlSeen, () => seen)
      const ctx = contextOf(step)
      await update($, baseline, b => Math.min(b > 0 ? b : ctx, ctx, BASELINE_CAP))
      await update($, hits, h => ({
        read: h.read + step.cacheRead,
        write: h.write + step.cacheWrite,
        total: h.total + step.input + step.cacheRead + step.cacheWrite,
        misses: h.misses + (prev && step.cacheRead < contextOf(prev) * 0.5 ? 1 : 0),
      }))
      await update($, last, () => step)
      await update($, note, () => null)
      await refreshStatus($)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.skip !== undefined) {
      return result
    }
    const before = result.tokensBefore
    const after = result.tokensAfter
    const out = result.usage?.output_tokens
    const b = await read($, baseline)
    if (before && out && before > b) {
      // Learn how long this session's summaries run, as a share of the conversation.
      const ratio = Math.min(0.5, Math.max(0.01, out / (before - b)))
      summaryRatio = summaryRatio * 0.5 + ratio * 0.5
      await $.store.set('summaryRatio', summaryRatio)
    }
    const how = { manual: '/compact', auto: '자동(임계치)', plugin: 'cache-meter', precompute: '' }[e.trigger]
    await update($, note, () =>
      before && after
        ? `compact됨 (${how}) ${fmtTokens(before)} → ${fmtTokens(after)} · 다음 메시지가 요약을 새로 캐시해요`
        : `compact됨 (${how}) · 다음 메시지가 요약을 새로 캐시해요`,
    )
    const at = await $.clock.now()
    await update($, compacted, () => ({ at, trigger: e.trigger }))
    await update($, last, () => null)
    await refreshStatus($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'cache-meter' }, async ($, e) => {
    const args = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'auto') {
      const mode = args[1]
      if (mode !== 'off' && mode !== 'idle' && mode !== 'always') {
        return { text: `자동 compact: ${AUTO_LABEL[auto]} (바꾸려면 /cache-meter auto off|idle|always)` }
      }
      return { text: await setAuto($, mode) }
    }
    if (args[0] === 'band') {
      const hidden = !(await read($, isBandHidden))
      await update($, isBandHidden, () => hidden)
      await refreshStatus($)
      return { text: hidden ? 'cache-meter status 줄을 숨겼어요.' : 'cache-meter status 줄을 다시 보여요.' }
    }
    await $.ui.open({ id: PANE, title: 'Cache meter' })
    return { text: 'Cache meter 창을 열었어요.' }
  })

  // The meter lives in the status line; the band above the prompt only appears to offer a compact.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await view($)
    const a = v.advice
    const showAction = v.isCompacting || (a?.isRecommended ?? false)
    if (!showAction && !v.note) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {v.note && !showAction ? <Text dimColor>{v.note}</Text> : null}
        {showAction && a ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Button
              key="compact"
              variant="primary"
              label={v.isCompacting ? 'compact 중…' : `compact (≈${fmtTokens(-a.saving)})`}
              onPress={() => compactNow($, 'button')}
            />
            <Text dimColor>
              {' '}
              {adviceLine(a, usdPerMTok)}
            </Text>
            <Button key="details" plain dimColor label=" 자세히" onPress={() => $.ui.open({ id: PANE, title: 'Cache meter' })} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const a = v.advice
    const usd = (t: number) => {
      const s = fmtUsd(t, usdPerMTok)
      return s ? ` (${s})` : ''
    }
    const ttlFrom = {
      setting: '설정값',
      observed: '이 세션에서 관측',
      plan: '구독 한도 안 → 1h 추정',
      default: 'API/크레딧 → 5m 추정',
    }[v.ttlSource]

    return (
      <Box flexDirection="column">
        <Text weight="bold">프롬프트 캐시</Text>
        {cacheText(Text, v)}
        <Text dimColor>TTL {v.ttl} ({ttlFrom})</Text>
        <Text>
          세션: 적중률 {pct(v.hits.read, v.hits.total)} · 읽기 {fmtTokens(v.hits.read)} · 쓰기{' '}
          {fmtTokens(v.hits.write)} · 캐시 덕분에 ≈{fmtTokens(cacheSaving(v))}{usd(cacheSaving(v))} 절약 · 재작성{' '}
          {v.hits.misses}회
        </Text>
        {v.step ? (
          <Text dimColor>
            마지막 요청: 읽기 {fmtTokens(v.step.cacheRead)} · 쓰기 {fmtTokens(v.step.cacheWrite)} · 비캐시{' '}
            {fmtTokens(v.step.input)} · 출력 {fmtTokens(v.step.output)} · {v.step.model}
          </Text>
        ) : (
          <Text dimColor>{v.note ?? '아직 이 세션의 응답이 없어요.'}</Text>
        )}
        <Text> </Text>
        <Text weight="bold">compact 손익 (향후 {cfg.horizon}턴, 입력 토큰 환산)</Text>
        {a ? (
          <Box flexDirection="column">
            <Text dimColor>
              상황: {KIND_LABEL[a.kind]} · 컨텍스트 {fmtTokens(a.contextTokens)} = 고정부(시스템·도구){' '}
              {fmtTokens(a.baselineTokens)} + 대화 {fmtTokens(a.contextTokens - a.baselineTokens)}
            </Text>
            <Text dimColor>
              compact 후 예상: {fmtTokens(a.afterTokens)} (요약 ≈{fmtTokens(a.summaryTokens)}, 요약 비율{' '}
              {Math.round(summaryRatio * 100)}%)
            </Text>
            <Text>유지: {fmtTokens(a.keepCost)}{usd(a.keepCost)}</Text>
            <Text>compact: {fmtTokens(a.compactCost)}{usd(a.compactCost)}</Text>
            <Text color={a.saving > 0 ? 'success' : 'subtle'}>
              {a.saving > 0 ? '절약' : '손해'}: {fmtTokens(Math.abs(a.saving))}
              {usd(Math.abs(a.saving))}
              {a.breakEvenTurns ? ` · 손익분기 ${a.breakEvenTurns}턴` : ''}
              {a.isRecommended ? ' → 추천' : ''}
            </Text>
            {a.kind === 'cold' ? (
              <Text color="warning">
                캐시가 이미 식었어요: 다음 메시지는 대화 {fmtTokens(a.contextTokens - a.baselineTokens)} 를 ×
                {WRITE[v.ttl]} 로 다시 씁니다.
              </Text>
            ) : null}
            <Text dimColor>compact는 요약이라 세부 내용이 빠질 수 있어요. 디버깅 중이면 신중히.</Text>
          </Box>
        ) : (
          <Text dimColor>응답이 하나 오면 계산해요.</Text>
        )}
        <Text> </Text>
        <Box flexDirection="row" flexWrap="wrap">
          <Button
            key="pane-compact"
            hotkey="c"
            variant={a?.isRecommended ? 'primary' : 'secondary'}
            label={v.isCompacting ? 'compact 중…' : '지금 compact'}
            onPress={() => compactNow($, 'button')}
          />
          <Text> </Text>
          <Button
            key="pane-auto"
            hotkey="a"
            label={`자동: ${AUTO_LABEL[auto]}`}
            onPress={async () => {
              $.ui.toast(await setAuto($, NEXT_AUTO[auto]))
            }}
          />
          <Text> </Text>
          <Button
            key="pane-band"
            hotkey="b"
            label="status 줄 숨김/표시"
            onPress={async () => {
              await update($, isBandHidden, h => !h)
              await refreshStatus($)
            }}
          />
        </Box>
        <Text dimColor>
          자동 모드 · 자리 비울 때만: 대기 중 캐시가 곧 만료될 때 · 항상: 추천 상태로 {IDLE_MS / 1000}초 이상 대기하면
        </Text>
      </Box>
    )
  })
}

type TextEl = ReturnType<EngineInterface['ui']['resolve']>['Text']

const SEP = '  │  '

/** What the cache saved this session over sending everything uncached, in input-token equivalents. */
function cacheSaving(v: View): number {
  return v.hits.read * (1 - READ) - v.hits.write * (WRITE[v.ttl] - 1)
}

/** One plain line, so it reads the same in any terminal font. */
function cacheState(v: View): string {
  const t = STATUS[v.lang]
  if (v.isCompacting) return t.compacting
  if (!v.step) {
    const c = v.compacted
    return c ? t.compacted(t.how[c.trigger] ?? c.trigger, fmtDuration(v.now - c.at)) : t.waiting
  }
  const left = remainingMs(v.step, v.ttl, v.now)
  if (left <= 0) {
    const rewrite = v.advice ? WRITE[v.ttl] * (v.advice.contextTokens - v.advice.baselineTokens) : 0
    return t.expired(fmtDuration(-left), fmtTokens(rewrite))
  }
  return `${left <= EXPIRING_MS[v.ttl] ? '⚠' : '●'} ${t.left(fmtDuration(left), v.ttl)}`
}

function statusLine(v: View): string {
  const t = STATUS[v.lang]
  const segs = [cacheState(v)]
  const s = v.step
  if (s) segs.push(t.hit(pct(s.cacheRead, s.input + s.cacheRead + s.cacheWrite), pct(v.hits.read, v.hits.total)))
  if (v.hits.total > 0) segs.push(t.saved(fmtTokens(cacheSaving(v))))
  if (v.hits.misses > 0) segs.push(t.rewrites(v.hits.misses))
  if (s) {
    const ctx = contextOf(s)
    segs.push(
      v.window > 0
        ? `ctx ${gauge(ctx / v.window)} ${pct(ctx, v.window)} ${fmtTokens(ctx)}/${fmtTokens(v.window)}`
        : `ctx ${fmtTokens(ctx)}`,
    )
  }
  segs.push(t.auto[v.auto])
  return segs.join(SEP)
}

function cacheText(Text: TextEl, v: View) {
  const left = v.step ? remainingMs(v.step, v.ttl, v.now) : 0
  const color = v.isCompacting ? 'claude' : !v.step ? 'subtle' : left <= 0 ? 'error' : left <= EXPIRING_MS[v.ttl] ? 'warning' : 'success'
  return <Text color={color}>{cacheState(v)}</Text>
}

function adviceLine(a: Advice, usdPerMTok: number): string {
  const usd = fmtUsd(a.saving, usdPerMTok)
  const why =
    a.kind === 'expiring'
      ? '캐시 만료 전에 줄이면'
      : a.kind === 'cold'
        ? '어차피 다시 써야 하니 줄이면'
        : a.breakEvenTurns
          ? `${a.breakEvenTurns}턴이면 본전, 계속하면`
          : '지금 줄이면'
  return `${why} ≈${fmtTokens(a.saving)}${usd ? ` (${usd})` : ''} 절약 · ctx ${fmtTokens(a.contextTokens)}→${fmtTokens(a.afterTokens)}`
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–'
}

function toLimit(l: { kind: string; percentUsed: number; resetsAt?: string }): RateLimit {
  return l.resetsAt ? { kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt } : { kind: l.kind, percentUsed: l.percentUsed }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

