import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const json = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const market = json('.claude-plugin/marketplace.json')

test('every mod folder has one marketplace entry, and back', () => {
  const dirs = readdirSync(new URL('../mods', import.meta.url)).sort()
  assert.deepEqual(market.plugins.map(p => p.name).sort(), dirs)
})

for (const entry of market.plugins) {
  test(`${entry.name}: entry matches its plugin.json and is listed`, () => {
    assert.equal(entry.source, `./mods/${entry.name}`)
    const manifest = json(`mods/${entry.name}/.claude-plugin/plugin.json`)
    assert.equal(manifest.name, entry.name)
    assert.equal(manifest.version, entry.version)
    assert.ok(read('README.md').includes(`[${entry.name}](mods/${entry.name})`), 'README table row')
    assert.ok(read('docs/mods.md').split(/\r?\n/).includes(`## ${entry.name}`), 'docs/mods.md section')
  })
}
