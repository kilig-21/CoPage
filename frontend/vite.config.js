import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const frontendDir = fileURLToPath(new URL('.', import.meta.url))

function buildSha(explicit) {
  const configured = explicit || process.env.GITHUB_SHA
  if (configured) return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(configured) ? configured : 'unknown'
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: frontendDir, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
    }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { 'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha(loadEnv(mode, frontendDir, 'VITE_BUILD_SHA').VITE_BUILD_SHA)) },
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(id)) return 'react-vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
}))
