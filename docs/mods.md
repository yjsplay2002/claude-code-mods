# 🧩 Mods

## cache-meter

How well this session uses the prompt cache, in the status line:

```
● 캐시 42m 남음 (1h)  │  적중 97% (세션 94%)  │  절약 ≈3.1M  │  재작성 1회  │  ctx 214k/1.0M
```

- Cache time left and TTL (5m or 1h), hit rate for the last request and the session, input-token equivalents the cache saved, and how often a cached prefix had to be re-written.
- A **compact** button above the prompt only when compacting is cheaper over the next turns; auto compact (`idle` by default) compacts when you are away and the cache is about to expire.
- `/cache-meter` opens a pane with the full breakdown. Usage limits (5h/7d) are left to other tools.

Details: [mods/cache-meter/README.md](../mods/cache-meter/README.md).

## ⚠️ Gotchas

- Claude Code prefixes a mod's status line with `⚠ <mod>:`. A mod can't remove it.
- A version bump is what makes `/plugin` update an installed copy.
- Changing the shape of a `$.state` value needs a new `shape` tag, or old sessions read the old value.
