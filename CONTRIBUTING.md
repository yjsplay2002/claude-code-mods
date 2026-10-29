# 🤝 Contributing

## 🧪 Try a mod locally

```sh
claude --plugin-dir mods/<name>
```

## ✅ Check it

```sh
claude plugin validate mods/<name>
claude plugin test mods/<name>
```

💡 `claude plugin test` may refuse to run inside a Claude Code session. If it does, run it with `CLAUDE_CONFIG_DIR` set to another config dir.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test mods/<name>
```

Then run the repo tests from the repo root:

```sh
node --test test/*.test.mjs
```

## 📦 Add a mod

- 📁 Put it in `mods/<name>/`, with `.claude-plugin/plugin.json`, `hooks/` and its tests
- 🧾 Add an entry to `.claude-plugin/marketplace.json`
- 📋 Add a row to the README table and notes to `docs/mods.md`

## 🔢 Change a mod

Bump its version in its `plugin.json` and in `.claude-plugin/marketplace.json`. `test/marketplace.test.mjs` checks the two match; installed copies only update when the version changes.

Gotchas: [docs/mods.md](docs/mods.md#-gotchas).
