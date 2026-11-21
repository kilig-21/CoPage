const sources = new Set(['render', 'window', 'rejection'])
const routes = new Set(['/login', '/home', '/account', '/docs', '/groups', '/projects', '/templates', '/search', '/trash'])
const errorKinds = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'])
const environments = new Set(['production', 'staging', 'development'])
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

const windowMs = 60_000
const browserLimit = 10

function routeFor(path) {
  if (routes.has(path)) return path
  return /^\/docs\/[^/]+\/?$/.test(path) ? '/docs/:id' : 'other'
}

export function createFrontendErrorReporter({ enabled, environment, release, sampleRate = 0.2,
  location, send, random = Math.random, now = Date.now }) {
  const recent = new Set()
  let windowStart = null
  const safeEnvironment = environments.has(environment) ? environment : 'development'
  const safeRelease = typeof release === 'string' && sha.test(release) ? release : 'unknown'
  const rate = Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : 0.2

  return (source, error) => {
    try {
      if (!enabled || !sources.has(source) || rate === 0) return
      const time = now()
      if (windowStart === null || time < windowStart || time - windowStart >= windowMs) {
        windowStart = time
        recent.clear()
      }
      if (recent.size >= browserLimit) return
      const route = routeFor(location())
      const name = error instanceof Error ? error.name : undefined
      const kind = errorKinds.has(name) ? name : 'unknown'
      const key = `${source}:${route}:${kind}`
      if (recent.has(key) || (rate < 1 && random() >= rate)) return
      recent.add(key)
      const payload = { source, route, kind, environment: safeEnvironment, release: safeRelease }
      Promise.resolve(send(payload)).catch(() => {})
    } catch { /* Diagnostics must never fail the page. */ }
  }
}

export function installFrontendErrorListeners(target, report) {
  const error = event => report('window', event.error)
  const rejection = event => report('rejection', event.reason)
  target.addEventListener('error', error)
  target.addEventListener('unhandledrejection', rejection)
  return () => {
    target.removeEventListener('error', error)
    target.removeEventListener('unhandledrejection', rejection)
  }
}

const env = import.meta.env ?? {}
const origin = (env.VITE_BACKEND_HTTP_ORIGIN ?? '').replace(/\/$/, '')
const setting = env.VITE_FRONTEND_ERROR_REPORTING_ENABLED
export const reportFrontendError = createFrontendErrorReporter({
  enabled: setting === 'true' || (setting !== 'false' && env.PROD === true),
  environment: env.PROD ? (env.MODE === 'production' ? 'production' : 'staging') : 'development',
  release: env.VITE_BUILD_SHA,
  sampleRate: env.VITE_FRONTEND_ERROR_SAMPLE_RATE === undefined ? undefined : Number(env.VITE_FRONTEND_ERROR_SAMPLE_RATE),
  location: () => window.location.pathname,
  send: payload => fetch(`${origin}/api/telemetry/frontend-errors`, {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
})
