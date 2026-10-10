import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'
import './styles/design-system.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: {
      colorPrimary: '#274de5', colorLink: '#274de5', colorLinkHover: '#1738bd', colorLinkActive: '#1738bd',
      colorText: '#232c39', colorTextSecondary: '#5c6572', colorTextDescription: '#5c6572',
      colorBgLayout: '#f7f6f2', colorBorder: '#dedfdc', colorBorderSecondary: '#e7e7e1',
      colorError: '#b42318', borderRadius: 10, controlHeight: 38, fontSize: 15,
      fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
    } }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
)
