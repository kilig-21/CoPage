# CODI-125 请求错误与页面提示

HTTP 客户端统一抛出带中文可读文案的 `Error`。HTTP 错误带数字 `code` 和 `status`，包括 `40901`～`40999` 的协同子码。服务端回复的 `code` 与 HTTP 状态匹配时，优先使用 300 字符内的中文单行提示。页面无需接触 Axios 配置、授权头、原始响应或代理返回的 HTML。受保护接口的 401 仍按发送请求时的账号和令牌处理失效，登录提交的 401 保留密码错误提示。

| 情况 | 默认提示 |
| --- | --- |
| 401 | 登录未通过或已失效，请核对账号和密码后重新登录。 |
| 403 | 当前账号没有权限执行此操作。 |
| 404 | 资源不存在或已被删除。 |
| 409 | 数据已发生变化或正在处理，请刷新后重试。 |
| 429 | 操作过于频繁，请稍后重试。 |
| 500 | 服务器处理失败，请稍后重试。 |
| 503 | 服务暂不可用，请稍后重试。 |
| `NETWORK_ERROR` | 无法连接服务，请检查网络后重试。 |
| `REQUEST_TIMEOUT` | 请求超时，请稍后重试。 |
| `REQUEST_FAILED` | 请求失败，请稍后重试。 |
| `ERR_CANCELED` | 请求已取消。 |

所有 Ant Design `message` 通过根 `App` 提供的上下文调用。API 适配器返回创建跟踪警告，当前操作页面在确认结果时展示。待确认的普通创建沿用页面内提示，避免重复弹出。创建失败时的确认与幂等重试仍由原流程处理。

## 本机验证

- `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify` 使用隔离 MySQL，455 项通过，无跳过。
- `npm --prefix frontend test` 472 项通过，包括 HTTP 映射、协同子码、超时、断网和取消。
- `npm --prefix frontend run build` 和 `node frontend/scripts/check-initial-bundles.mjs` 通过。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi123-verified` 使用随机 Compose 项目和独立 Chrome，9 项通过，43.5 秒。浏览器实测登录后端返回 401、离线和应用默认的 10 秒超时。测试拦截分支分别返回 403、404、409、429、500、503，以验证代理返回非 JSON 时的页面文案。文档创建的 503 同样由测试注入，复测同一次创建可继续成功。临时 Compose 资源已清理。
- 另外在 Vite 开发模式验证文档列表只显示一条 503 提示，图标使用项目色 `rgb(180, 35, 24)`，控制台未出现 Ant Design 静态调用上下文告警。[Chrome 1280 × 800 截图](assets/codi125/document-create-unavailable.png)
