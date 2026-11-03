# 🧩 Mods

## cache-meter

How well this session uses the prompt cache, in the status line:

```
● cache 42m left (1h)  │  hit 97% (session 94%)  │  Cache misses 1 (context re-written)  │  ctx ██░░░░░░░░ 21% 214k/1.0M  │  Auto Compact Mode: Idle
```

- Cache time left and TTL (5m or 1h), hit rate for the last request and the session, and how often a cached prefix had to be re-written.
- A context gauge against the model's window, and the auto compact mode (`Off`, `Idle`, `Always`).
- After a compaction it shows `◇ compacted (…)` until the next reply; a lapsed cache that was not compacted ends in `· not compacted`.
- English by default; set `language` to `ko` for Korean.
- A **compact** button above the prompt only when compacting is cheaper over the next turns; auto compact (`idle` by default) compacts when you are away and the cache is about to expire.
- `/cache-meter` opens a pane with the full breakdown. Usage limits (5h/7d) are left to other tools.

Details: [mods/cache-meter/README.md](../mods/cache-meter/README.md).

## ⚠️ Gotchas

- Claude Code prefixes a mod's status line with `⚠ <mod>:`. A mod can't remove it.
- A version bump is what makes `/plugin` update an installed copy. Auto-update for a third-party marketplace stays off until you turn it on in `/plugin` → Marketplaces.
- Changing the shape of a `$.state` value needs a new `shape` tag, or old sessions read the old value.
