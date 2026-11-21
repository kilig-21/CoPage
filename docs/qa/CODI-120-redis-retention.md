# CODI-120 Redis 缓存与在线状态验收

## 验证命令

```text
mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify
npm --prefix frontend test
npm --prefix frontend run build
node scripts/production-compose-check.mjs --redis-retention-smoke --runtime-image=copage-backend:codi120-verified
```

2026-11-22 的后端 451 项测试、前端 458 项测试和 Vite 构建均通过。Maven 使用临时 MySQL 8.4.3，迁移测试连接方式见[数据库结构迁移](../数据库结构迁移.md)。Compose 使用随机项目、独立数据卷与两个生产配置后端。镜像使用上述 Maven 构建的 JAR 和已有的非 root 运行环境。烟测将文档缓存 TTL 调为 12 秒，在线租约使用默认时限。以下烟测全部通过，退出码为 0。双实例通用协作烟测同时验证了 30 次并发提交全部确认，最终 revision 为 34。隔离容器、网络和卷已清理。

## 验证覆盖

- 读取真实 Redis 的三个正文缓存键的 TTL。过期后，从另一实例通过 WebSocket 读取 MySQL 的正文和历史并继续写入。
- 同一文档连接到两个实例，只推进其中一个合成会话的截止时间。观察巡检移除该会话并保留另一实例连接，原连接心跳重新登记。
- 软删立即移除五个文档缓存和在线状态键及到期索引成员。恢复后原版本和正文可继续读取。测试也覆盖清理失败时仍通知实例及已恢复文档跳过清理。
- 合成 Redis 独有的旧版本在软删与恢复之间保留。重新打开时补写到 MySQL，之后各缓存键才开始计时。
- 两个后端同时暂停，验证在线状态键在 Redis 内到期。恢复后巡检清除索引成员。Redis `INFO commandstats` 的 `SCAN` 计数保持不变。

首轮数据库联测发现，删除提交后的搜索回调在原连接写入索引回执，随后清理过程的独立事务等待同一行锁并超时。同步索引回调改用独立事务提交回执。软删烟测通过 HTTP 请求核对清理时序。

## 边界

- 当前产品提供回收站和恢复。永久删除没有对用户开放的接口。
- 既有但未重新访问的 Redis 热状态可能长期没有 TTL。需在确认其对应版本已经持久化之后才能清理。旧版在线状态的一次性回收步骤见[部署说明](../后端服务器部署.md)。
- 使用真实 HTTP、WebSocket、Redis 和 MySQL 验证后端行为。未采集新浏览器截图、默认 Dockerfile 源码构建结果或长期 Redis 内存和 CPU 趋势。
