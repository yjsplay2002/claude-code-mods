export type Ttl = '5m' | '1h'

/** One model request of the main conversation, as its usage reported it. */
export type MainStep = {
  at: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  model: string
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** Session totals of the main conversation's requests. `misses` counts requests that re-wrote a prefix the previous one had cached. */
export type HitTotals = { read: number; write: number; total: number; misses: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      last: Shaped<MainStep | null>
      baseline: number
      hits: Shaped<HitTotals>
      limits: Shaped<RateLimit[]>
      window: number
      ttlSeen: Ttl | null
      isBusy: boolean
      isCompacting: boolean
      tick: number
      note: string | null
      isBandHidden: boolean
    }
  }
}
