import { useState } from 'react'

export default function StorageUnavailable({ onRetry }) {
  const [notice, setNotice] = useState('')
  return <main className="page-load-message" role="alert">
    <h1>浏览器存储暂时不可用</h1>
    <p>CoPage需要浏览器保存登录状态、本地草稿和当前标签的信息。请允许此站点使用Cookie和站点数据，再重试。</p>
    <p>已有草稿没有被清除，请不要为重试清空站点数据。当前地址会保留，允许存储后可继续打开。</p>
    <button onClick={() => {
      if (!onRetry()) setNotice('仍无法读取浏览器存储，请检查本站的数据访问设置后重试。')
    }}>重试存储访问</button>
    {notice && <p role="status">{notice}</p>}
  </main>
}
