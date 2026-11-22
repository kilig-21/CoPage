# CODI-128 前端静态检查与协同协议兼容

删除未被引用的 `zustand`、锁文件条目和空的 `src/store/`。前端使用 ESLint 10 平面配置，覆盖应用、构建脚本和 Playwright，用 `npm --prefix frontend run lint` 运行。CI 将告警视为失败。启用 `rules-of-hooks`、`exhaustive-deps`、未声明变量、重复参数、不可达代码和调试断点检查。Node.js 最低版本为 22 系列的 22.13.0，24 及以上也受支持。README 和 Windows 启动检查已同步。 [ESLint Node.js 要求](https://eslint.org/docs/latest/use/getting-started/) · [React Hooks 规则](https://react.dev/reference/eslint-plugin-react-hooks)

补齐稳定请求对象和作用域键的 effect 依赖，用稳定回调及显式的清理上下文维持撤权、换号、取消读取和待确认操作的语义。`Groups.jsx` 保留两条例外，位置均有行级说明。

- 邀请收件箱的请求由其页码、重试标记及绑定身份驱动。列表筛选变化无需取消邀请读取。
- 小组详情读取由所选小组、归档模式、刷新标记及绑定身份驱动。列表筛选变化无需打断原资料核对，仍通过目标 ID、操作 epoch 和请求取消标记校验。

WebSocket 在消息交给编辑器前检查已知类型及可选 `docId`，扩展类型不会触发状态或权限更新。未知本地状态显示中文兜底。业务字段继续由相应处理器校验，例如连贯 revision、操作收据、账号资料及登录响应。保留现有 API 和 WebSocket 请求格式，无新增通用 schema 依赖。

## 本机验证

- `npm --prefix frontend ls zustand --all` 输出 `(empty)`，包清单和锁文件也无 Zustand 条目。`npm --prefix frontend run lint` 通过，前端 `npm --prefix frontend test` 478 项通过。单测覆盖未知状态、中性回退提示及带伪权限值的未知类型。
- 隔离 Redis 与 MySQL 的 `mvn verify` 475 项通过，Vite 构建及首屏依赖检查通过。Windows 启动脚本语法通过，实际版本判断验证了 22.12、22.13、23 和 24 四种版本。
- 在真实 Chrome 访问小组及收件箱、项目、账号三个页面。预期接口均返回 200，各请求发出一次，控制台无页面异常。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi127-verified` 通过 10 项隔离 Chromium 验收，耗时 1.2 分钟。浏览器收到携带 `permission: 0` 的扩展事件后仍可编辑和跨实例追赶，实际权限不受影响。临时 Compose 资源已清理。
- `npm --prefix frontend audit --audit-level=moderate` 通过，同一份锁文件仍有 Quill 2.0.3 的既有低风险告警。[GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25)
