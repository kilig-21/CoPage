# CODI-127 协同增量追赶与 Redis 降级

客户端收到跳号广播、跳号 ACK 或心跳中的更高 MySQL revision 时，沿用当前 WebSocket 发送 `history_request`。目标 revision 在分页期间固定，操作依次应用到工作副本。第一请求可校验当前用户、文档、clientId 和原操作的持久收据。迟到的消息更新追赶上界而无需在浏览器缓存报文。每页最多四次请求，已裁剪或不连续的历史回退到 `join`。如果快照版本倒退或还有无法安全合并的本地编辑，页面暂停协同并保留正文和草稿供用户复制。

`join` 在分布式锁内读取 revision 界限并注册本机订阅，返回后才处理在线状态、序列化和发送。操作提交放锁后才入队 MQ、发送 ACK 和广播，因此跨实例可能先收到后提交的 revision，客户端按 MySQL 历史补齐。锁仍使用 10 秒可续租、1 秒等待，等待间隔和客户端重试加入抖动。MySQL 修改正文和保存收据同事务执行。Redis 写入脚本检查当前租约令牌和热状态 revision，旧租约或反向版本不能覆盖新状态。一次已持久化提交在失锁后仍返回原 revision，重试由原 `opId` 命中收据。

旧 Redis 领先 MySQL 时，完整且可重放、能重建相同热正文的链才补写到 MySQL。校验最多 2,000 条、累计 16 MiB，缺口、坏 JSON、格式错误或超限时，以 MySQL 内容继续工作。当前租约内把原 Redis 值移到 `collab:doc:quarantine:<docId>:<批次ID>:{content,revision,ops}`，记录文档编号、版本、归档前缀及失败类别，并以 MySQL 重建带 TTL 的热键。归档无自动过期，无自动回放。处理归档时，先按该文档的保留要求备份并核对，再决定是否恢复为独立副本。Redis 在读写前完全不可达时，获取文档锁仍可能失败。需要可恢复迁移时应备份 Redis 卷及持久化配置。

## 本机验证

- `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify` 使用隔离 MySQL 与 Redis，475 项通过，无跳过。真实 Redis 测试替换租约，证明旧租约和旧 revision 都不能覆盖新热状态。验证协同收据、并发提交不被慢 ACK 阻塞、失败归档前无 MySQL 写入、坏状态归档和带 TTL 的重建。
- `npm --prefix frontend test` 476 项通过。`npm --prefix frontend run build` 和 `node frontend/scripts/check-initial-bundles.mjs` 通过。
- 用 `copage-backend:codi127-verified` 启动合成 Compose 环境。初始 MySQL revision 1、Redis revision 2 且历史连续时，MySQL 正文和操作行补齐到 2。另一个文档缺失 revision 2，服务返回 MySQL revision 1，Redis 原始 content、revision、ops 三个键转入持久归档，关键信息有告警。随后接受基于 revision 1 的新编辑，并保持归档可读。
- 通过真实 WebSocket 写入 1,220,000 字符的操作。重加入发出 1,220,320 字节 `sync`，`historyPaged=true` 且内嵌历史为空。原操作通过单独的 1,220,198 字节 `history_page` 返回。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi127-verified` 通过双实例协同烟测和全部 10 条 Chromium 用例，浏览器部分耗时 1.2 分钟。两位浏览器用户各连接一个后端。只在接收方测试路由丢弃 revision 1 与最后一条 revision 3，分别由后续广播和实际 20 秒心跳触发历史追赶。双方各仅加入一次，接收方保持同一条 WebSocket。首次尝试的测试路由未切到第二端口，最终用例显式核对端口并通过。随机环境资源已清理。
