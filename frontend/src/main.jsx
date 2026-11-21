import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import { antTheme, applyThemeVariables } from './styles/theme'
import { installFrontendErrorListeners, reportFrontendError } from './observability/frontendErrors'
import './styles.css'
import './styles/design-system.css'

installFrontendErrorListeners(window, reportFrontendError)
applyThemeVariables(document.documentElement.style)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={antTheme}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
)
