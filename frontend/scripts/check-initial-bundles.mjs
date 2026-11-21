import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const initialDist = fileURLToPath(new URL('../dist', import.meta.url))
const [dist = initialDist, baseline] = process.argv.slice(2)

function loadBuild(directory) {
  const root = resolve(directory)
  const manifest = JSON.parse(readFileSync(join(root, '.vite', 'manifest.json'), 'utf8'))
  const sizes = new Map()

  function total(files) {
    let raw = 0
    let gzip = 0
    for (const file of files) {
      if (!sizes.has(file)) {
        const bytes = readFileSync(join(root, file))
        sizes.set(file, { raw: bytes.length, gzip: gzipSync(bytes).length })
      }
      raw += sizes.get(file).raw
      gzip += sizes.get(file).gzip
    }
    return { raw, gzip }
  }

  function initialFiles(route) {
    const pending = ['index.html', route]
    const seen = new Set()
    const files = new Set()
    while (pending.length) {
      const id = pending.pop()
      if (seen.has(id)) continue
      seen.add(id)
      const chunk = manifest[id]
      assert.ok(chunk, `Manifest entry is missing for ${id}`)
      if (chunk.file.endsWith('.js')) files.add(chunk.file)
      pending.push(...(chunk.imports ?? []))
    }
    return files
  }

  return { manifest, initialFiles, total }
}

const candidate = loadBuild(dist)
const previous = baseline ? loadBuild(baseline) : null
const guide = candidate.manifest['src/components/UserGuide.jsx']
assert.ok(guide?.isDynamicEntry, 'UserGuide must emit a dynamic entry')
const routes = Object.keys(candidate.manifest).filter(id => id.startsWith('src/pages/') && candidate.manifest[id].isDynamicEntry)
for (const page of ['src/pages/Login.jsx', 'src/pages/Home.jsx', 'src/pages/Editor.jsx']) {
  assert.ok(routes.includes(page), `Expected a lazy route for ${page}`)
}

const rows = ['index.html', ...routes.sort()].map(route => {
  const initial = candidate.initialFiles(route)
  assert.ok(!initial.has(guide.file), `UserGuide is in the initial dependency graph of ${route}`)
  const { raw, gzip } = candidate.total(initial)
  const old = previous?.total(previous.initialFiles(route))
  return {
    route, 'raw B': raw, 'gzip B': gzip,
    ...(old ? { 'previous gzip B': old.gzip, 'gzip change B': gzip - old.gzip } : {}),
  }
})
console.table(rows)
const { raw, gzip } = candidate.total([guide.file])
console.log(`On-demand UserGuide: ${raw} raw B, ${gzip} gzip B`)
