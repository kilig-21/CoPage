import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrontendErrorReporter, installFrontendErrorListeners } from './frontendErrors.js'

const release = '123456789a'.repeat(4)

test('the payload contains only allowlisted route, error kind, source, environment and release', () => {
  const reports = []
  const report = createFrontendErrorReporter({ enabled: true, environment: 'production', release,
    location: () => '/docs/private-user-id', sampleRate: 1, send: data => reports.push(data),
  })
  const error = new TypeError('body user=demo-account token=private-token')
  error.stack = 'private document content and full address'
  report('render', error)
  assert.deepEqual(reports, [{ source: 'render', route: '/docs/:id', kind: 'TypeError', environment: 'production', release }])
})

test('arbitrary error names, releases, paths and rejection objects are discarded', () => {
  const reports = []
  const report = createFrontendErrorReporter({ enabled: true, environment: 'private_organization', release: 'secret',
    location: () => '/private/path', sampleRate: 1, send: data => reports.push(data),
  })
  const error = new Error('private-message')
  error.name = 'custom-secret'
  report('window', error)
  report('rejection', { reason: 'sensitive rejection' })
  report('untrusted-source', error)
  assert.deepEqual(reports, ['window', 'rejection'].map(source => ({
    source, route: 'other', kind: 'unknown', environment: 'development', release: 'unknown',
  })))
})

test('sampling is configurable, identical errors are grouped, and each minute has a bounded budget', () => {
  const reports = []
  let count = 0, time = 500, path = '/login', random = 0.9
  const report = createFrontendErrorReporter({ enabled: true, environment: 'staging', release,
    location: () => path, sampleRate: 0.5, now: () => time, random: () => random,
    send: data => { reports.push(data); count++ },
  })
  report('render', new Error('sampled out'))
  assert.equal(count, 0)
  random = 0.1
  report('render', new Error('first'))
  report('render', new Error('same group, different message'))
  assert.equal(count, 1)
  for (const route of ['/home', '/docs', '/account', '/projects', '/groups', '/templates', '/search', '/trash', '/docs/1', '/ignored']) {
    path = route
    report('window', new Error())
  }
  assert.equal(reports.length, 10)
  time += 60_000
  report('window', new Error())
  assert.equal(reports.length, 11)
})

test('disabled reporting and transport failures never propagate to the application', async () => {
  const location = () => '/login'
  const disabled = createFrontendErrorReporter({ enabled: false, location, sampleRate: 1,
    send: () => { assert.fail('disabled reporter tried to send') },
  })
  disabled('render', new Error())
  const zero = createFrontendErrorReporter({ enabled: true, location, sampleRate: 0,
    send: () => { assert.fail('zero sample rate tried to send') },
  })
  zero('window', new Error())
  for (const send of [() => { throw new Error('offline') }, () => Promise.reject(new Error('offline'))]) {
    const report = createFrontendErrorReporter({ enabled: true, location, sampleRate: 1, send })
    assert.doesNotThrow(() => report('rejection', new Error()))
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('global listeners classify the events and can be removed', () => {
  const target = new EventTarget()
  const collected = []
  const remove = installFrontendErrorListeners(target, (...args) => collected.push(args))
  const error = new Error('sample')
  const windowError = Object.assign(new Event('error'), { error })
  const rejection = Object.assign(new Event('unhandledrejection'), { reason: error })
  target.dispatchEvent(windowError)
  target.dispatchEvent(rejection)
  remove()
  target.dispatchEvent(rejection)
  assert.deepEqual(collected, [['window', error], ['rejection', error]])
})
