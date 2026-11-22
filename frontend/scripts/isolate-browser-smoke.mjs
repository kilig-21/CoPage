import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const frontend = fileURLToPath(new URL('../', import.meta.url))

export async function isolateBrowserSmoke() {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = mkdtempSync(join(temporaryRoot, 'copage-browser-qa-'))
  const dist = join(directory, 'dist')
  mkdirSync(dist)
  const removeBuild = () => {
    const resolved = realpathSync(directory)
    if (dirname(resolved) !== temporaryRoot || !basename(resolved).startsWith('copage-browser-qa-')) {
      throw new Error('Refusing to remove a path outside the temporary browser fixture')
    }
    rmSync(resolved, { recursive: true })
  }
  let server
  try {
    server = await preview({ configFile: false, root: frontend, build: { outDir: dist },
      preview: { host: '127.0.0.1', port: 0 },
    })
  } catch (error) {
    removeBuild()
    throw error
  }
  const port = server.httpServer.address().port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    directory,
    async run({ backendPort, secondaryPort, project }) {
      const env = { ...process.env,
        VITE_BACKEND_HTTP_ORIGIN: `http://127.0.0.1:${backendPort}`,
        VITE_BACKEND_WS_ORIGIN: `ws://127.0.0.1:${backendPort}`,
        VITE_FRONTEND_ERROR_REPORTING_ENABLED: 'false',
        COPAGE_E2E_FRONTEND_ORIGIN: origin,
        COPAGE_E2E_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
        COPAGE_E2E_SECONDARY_BACKEND_ORIGIN: `http://127.0.0.1:${secondaryPort}`,
        COPAGE_E2E_PROJECT: project,
      }
      const build = spawnSync(process.execPath,
        ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'],
        { cwd: frontend, env, stdio: 'inherit' })
      if (build.error || build.status !== 0) throw build.error ?? new Error('Isolated frontend build failed')
      console.log('PASS: built the frontend for the isolated browser project')
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'],
          { cwd: frontend, env, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', code => {
          if (code === 0) resolve()
          else reject(new Error(`Playwright smoke failed (exit ${code})`))
        })
      })
    },
    async close() {
      server.httpServer.closeAllConnections()
      await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
      removeBuild()
    },
  }
}
