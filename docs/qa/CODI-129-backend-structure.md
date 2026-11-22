# CODI-129 后端代码清理

- 删除 `OpIterator.ensureHasNext` 和没有业务注入点的自定义 Redis 通用序列化配置。协同数据继续通过 `StringRedisTemplate` 和既有 JSON 读写，Redis 键和值格式一致。
- `CollabMessages` 构造在线状态及历史数组，`PresenceColor` 提供在线用户与光标的相同颜色。`CollabEventBus` 处理 Redis 信封，`CollabEventDelivery` 负责转发时的会话有效性、文档权限及关闭连接。原始 WebSocket 回包字段保持兼容。
- `DeltaJson` 作为 Redis、MySQL 文档与历史的共用编码入口，保留调用点的缺值和出错语义。搜索正文同样复用 Delta 的文本提取，忽略图片对象与属性。`ElasticsearchTransport` 持有 HTTP 客户端和请求超时，`SearchIndex` 管理索引版本、建索引和有界巡检。索引的巡检仍与游标一起维护。
- 协同提交依次检查原收据、验证基线、变换操作及计算正文，然后提交 MySQL 与热状态。Redis 热更新失败时仍按已持久化结果确认。通知客户端和 MQ 继续在文档锁之外。
- 内存状态测试实现的 `save` 自身使用可重入文档锁。`HistoryMaintenance` 用原子运行标记避免重叠批次等待数据库 I/O，仍保留单文档锁与保护名单。

复核时发现，数据库启动 DDL 已由 Flyway 处理。同一底层 WebSocket 的装饰器也已复用，已有测试验证重加入沿用同一发送锁，这两处无需再改。

## 本机验证

- 前端 `npm test` 478 项通过，`npm run lint`、`npm run build` 和首屏依赖检查通过。
- 隔离 MySQL 与 Redis 下执行 `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify`，478 项通过，无失败或跳过。保留收据复用、日志缺口、快照归档、撤权与消息转发等回归。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi129-verified` 的双实例协同烟测通过，Playwright 10 项通过，最后一次结果无失败项。验收容器已退出并清理。
- Delta 测试保留既有属性移除、非法操作拒绝的覆盖，新增持久 JSON 往返、UTF-8 字节数、图片忽略和解析错误测试。维护重叠测试验证第二轮立即返回，第一轮结束后可继续处理。
