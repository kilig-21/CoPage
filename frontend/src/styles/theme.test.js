import test from 'node:test'
import assert from 'node:assert/strict'
import { antTheme, applyThemeVariables } from './theme.js'

function luminance(hex) {
  const [red, green, blue] = hex.slice(1).match(/../g).map((pair) => {
    const channel = Number.parseInt(pair, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

test('CSS and Ant Design share the same palette and control sizing', () => {
  const variables = new Map()
  applyThemeVariables({ setProperty: (name, value) => variables.set(name, value) })
  const { token } = antTheme
  assert.equal(variables.get('--cp-accent'), token.colorPrimary)
  assert.equal(variables.get('--cp-ink'), token.colorText)
  assert.equal(variables.get('--cp-muted'), token.colorTextSecondary)
  assert.equal(variables.get('--cp-surface'), token.colorBgContainer)
  assert.equal(variables.get('--cp-radius-panel'), `${token.borderRadius}px`)
  assert.equal(variables.get('--cp-control-height'), `${token.controlHeight}px`)
})

test('body, auxiliary and semantic text have 4.5:1 contrast on page and card surfaces', () => {
  const { token } = antTheme
  const textColors = [token.colorText, token.colorTextSecondary, token.colorPrimary,
    token.colorSuccess, token.colorWarning, token.colorError]
  for (const background of [token.colorBgLayout, token.colorBgContainer]) {
    for (const foreground of textColors) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`)
    }
  }
})
