const palette = {
  ink: '#232c39',
  muted: '#5c6572',
  accent: '#274de5',
  'accent-hover': '#1738bd',
  'accent-soft': '#edf0ff',
  line: '#dedfdc',
  'line-soft': '#e7e7e1',
  paper: '#f7f6f2',
  surface: '#fffefa',
  'surface-hover': '#f0f0e9',
  'status-success': '#237804',
  'status-warning': '#874d00',
  'status-error': '#b42318',
}

const fontFamily = '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
const fontSize = 15
const borderRadius = 10
const controlHeight = 38

export const antTheme = {
  token: {
    colorPrimary: palette.accent,
    colorLink: palette.accent,
    colorLinkHover: palette['accent-hover'],
    colorLinkActive: palette['accent-hover'],
    colorText: palette.ink,
    colorTextSecondary: palette.muted,
    colorTextDescription: palette.muted,
    colorBgLayout: palette.paper,
    colorBgContainer: palette.surface,
    colorBgElevated: palette.surface,
    colorBorder: palette.line,
    colorBorderSecondary: palette['line-soft'],
    colorSuccess: palette['status-success'],
    colorWarning: palette['status-warning'],
    colorError: palette['status-error'],
    fontFamily,
    fontSize,
    borderRadius,
    controlHeight,
  },
}

export function applyThemeVariables(style) {
  for (const [name, value] of Object.entries(palette)) {
    style.setProperty(`--cp-${name}`, value)
  }
  style.setProperty('--cp-sans', fontFamily)
  style.setProperty('--cp-type-body', `${fontSize}px`)
  style.setProperty('--cp-radius-panel', `${borderRadius}px`)
  style.setProperty('--cp-control-height', `${controlHeight}px`)
}
