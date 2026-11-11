# claude-code-mods

[Claude Code](https://claude.com/claude-code) mods by yjsplay2002. Requires Claude Code v2.1.287 or later.

## 📥 Install

```sh
claude plugin marketplace add yjsplay2002/claude-code-mods
claude plugin install <name>@claude-code-mods
```

Or inside Claude Code: `/plugin install <name> --marketplace yjsplay2002/claude-code-mods`.

Updates arrive only when a mod's version changes. To get them on their own, turn on auto-update for this marketplace: `/plugin` → Marketplaces → `claude-code-mods` → Enable auto-update (checked at startup). In a running session: `/plugin marketplace update claude-code-mods`, then `/reload-plugins`.

## 🧩 Mods

| Mod | What it does | Category |
| --- | --- | --- |
| [cache-meter](mods/cache-meter) | How well this session uses the prompt cache, in the status line: time left, hit rate, cache misses, a context gauge and the auto compact mode, in English or Korean. A compact button when compacting is cheaper than carrying the context. | Spend less |
| [ai-office](https://github.com/yjsplay2002/ai-office) | An AI office for a one-person business: a PM session hands work to persona subagents, keeps TODOs and decisions in board/, and shows the team at work in a local 3D forest-office dashboard. /ai-office:init interviews you and sets it up. | Run a team |

Notes on each mod: [docs/mods.md](docs/mods.md). Adding or changing one: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
