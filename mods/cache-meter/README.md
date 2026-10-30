# cache-meter

English · [한국어](README.ko.md)

A Claude Code mod that shows, in the status line, how well this session uses the
prompt cache: time left before it expires, hit rate, tokens it saved and how
often it had to be rebuilt. When compacting the
conversation is cheaper than carrying it, a **compact** button appears above
the prompt. Auto compact (`idle`, on by default) compacts for you when you step
away and the cache is about to expire.

Status line, always:

```
● cache 42m left (1h)  │  hit 97% (session 94%)  │  Cache saved ≈3.1M  │  Cache misses 1 (context re-written)  │  ctx ██░░░░░░░░ 21% 214k/1.0M  │  Auto Compact Mode: Idle
```
After a compaction, until the next reply: `◇ compacted (cache-meter, 7m ago) · waiting for the first reply`. A lapsed cache that was not compacted ends in `· not compacted`. Set `language` to `ko` for a Korean status line.


Above the prompt, only when compacting pays off:

```
[ compact (≈-109k) ]  7턴이면 본전, 계속하면 ≈109k 절약 · ctx 214k→44k   자세히
```

The labels are in Korean.

Requires Claude Code v2.1.287 or later (mods).

## Why

Long Claude Code sessions are billed (and drawn from subscription limits)
mostly by how the prompt cache behaves: a warm cache re-reads the context at
0.1x, but once it lapses the next message re-writes the whole context at
1.25x–2x. That cost is invisible while you work.

Existing tools each covered part of it: status lines such as
`claude-code-usage-bar` (defaults to a 5-minute TTL, wrong for 1-hour
subscription caches), `claude-code-statusline`, `claude-vibeline`, dashboards
like `agentmeter` and `claude-lens`, or local proxies that route all traffic
through third-party code. None of them answers the practical question: *is it
cheaper right now to compact this conversation than to keep carrying it?*

cache-meter is built as a Claude Code mod so it can read the cache state and
usage limits Claude Code itself reports, and act on them:

- see at a glance whether the cache is warm, how long it has left, and what a
  cold cache will cost on the next message;
- get a one-click **compact** button only when compacting actually saves
  tokens, with the break-even turn count, plus an optional auto-compact for
  when you step away and the cache is about to expire.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-meter --marketplace yjsplay2002/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope (user is the default).

From a shell:

```
claude plugin install cache-meter --marketplace yjsplay2002/claude-code-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `yjsplay2002/claude-code-mods`, then
Add plugin.

## What it shows

- **Cache**: time left before the main conversation's prompt cache expires,
  and its TTL (5m or 1h). `●` warm, `⚠` about to expire,
  `✕` cold, with what the next message will re-write. Every request that reads
  the cache resets the timer, so it only counts down while you are idle.
- **Hit rate**: the share of the last request's input served from cache, and of the whole session.
- **Saved**: input-token equivalents the cache saved this session (reads at 0.1x, minus the write premium).
- **Rebuilds**: requests that had to re-write a prefix the previous request had cached.
- **Context**: what the next request re-sends, against the model's window.

Usage limits are left to other tools.

`/cache-meter` opens a pane with the full breakdown, the cost comparison and
buttons: `c` compact now, `a` cycle auto mode, `b` hide or show the status line
(also `/cache-meter band`).

## When it suggests compacting

Costs are in input-token equivalents, using Anthropic's multipliers on the base
input price: cache read 0.1x, cache write 1.25x (5m) or 2x (1h), output 5x.
Subscription limits are drawn down by the same weights.

Over the next *N* turns (default 15) it compares:

- **Keep**: every turn re-reads the whole context from cache.
- **Compact now**: the summarizer reads the context once, writes a summary
  (output price), the next turn caches the summary, later turns read the
  smaller context.

Three situations are told apart:

| Situation | Keeping costs | Why compacting can win |
| --- | --- | --- |
| active (cache warm) | N × 0.1 × context | each later turn reads less |
| expiring (idle, cache about to lapse) | a full re-write when you come back | the summarizer still reads the warm cache |
| cold (cache lapsed) | a full re-write next message | later turns read less |

It suggests compacting when the context is at least 80k tokens and the saving at
least 40k input-token equivalents. Summary length is learned from this
machine's own compactions. Compaction is lossy: in a detail-heavy debugging
session, keep the context.

## Auto compact

Set in `/config` (cache-meter → Auto compact), with `/cache-meter auto
off|idle|always`, or the pane's `a` button:

- `off`: never.
- `idle` (default): only when no turn runs, nothing was typed for 90 s, and the cache is
  about to expire (under 8 min left on 1h, 75 s on 5m).
- `always`: also when compacting is recommended and the session has been idle
  for 90 s.

Claude Code's own idle compaction (2.1.299+) also compacts 200k+ conversations
before a one-hour cache expires; `idle` mode extends that to smaller contexts
and to the 5-minute cache.

## Settings

| Field | Default | Meaning |
| --- | --- | --- |
| `autoCompact` | `idle` | `off`, `idle` or `always` |
| `horizonTurns` | 15 | turns the comparison runs over |
| `minContextTokens` | 80000 | no suggestion below this context |
| `minSavingTokens` | 40000 | no suggestion below this saving |
| `ttl` | `auto` | force `5m` or `1h`; `auto` infers it from your plan and the cache's behaviour |
| `inputUsdPerMTok` | 0 | your model's input price, to show dollars too |
| `language` | en | status line language: `en` or `ko` |

## Development

```
claude --plugin-dir ./            # load from this folder, hot-reloads on save
claude plugin validate .
claude plugin test .
```
