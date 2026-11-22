# CODI-126 RabbitMQ 确认与快照补偿

协同提交完成后，操作事件交给每实例两个专用发布线程，队列上限 256。线程饱和时记录缺失的通知，文档锁内的调用线程继续返回 MySQL 已提交的结果。操作及快照通知都要求 correlated confirm、mandatory 路由和零返回消息。确认超时、`NACK`、`RETURNED` 或连接错误都会重试，最多发送三次，每次使用独立确认 ID。超时后重试可能产生重复投递，快照写入使用文档行锁并检查已有快照。升级沿用原队列名称、绑定和 JSON。 [Spring AMQP 确认与返回](https://docs.spring.io/spring-amqp/reference/3.2/amqp/template.html#template-confirms)

操作与快照队列默认每实例分别由两个消费者处理，每消费者预取 16 条。无效 JSON 或非正数标识直接进入 `doc.dead.queue`。操作行已裁剪且 revision 小于或等于保留边界时正常确认，只有边界以上缺失的操作才进入死信。数据库或事务暂时失败时，消费同一投递最多尝试三次，之后拒绝重入主队列。快照通知发布失败时可直接尝试 MySQL 快照，系统仍保留定时补偿。

## 延迟与配置

快照补偿默认启动后 30 秒开始，之后每轮结束 60 秒后继续。MySQL 可用、当前一批能覆盖该文档时，漏通知会在下一轮补齐。单轮按文档 ID 取至多 100 份，积压由多轮消化。ES 协同写索引使用 CODI-112 已建立的持久待处理标记，每轮合并同一文档的多次写入。默认搜索间隔为 5 秒，搜索可见时间还取决于 ES 刷新、积压和服务恢复。

| 后端环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MQ_CONFIRM_TIMEOUT_MS` | 1500 | 每次发布后等待确认的毫秒数，建连耗时单独计算 |
| `MQ_OPERATION_CONSUMERS` | 2 | 每实例操作队列消费者数 |
| `MQ_SNAPSHOT_CONSUMERS` | 2 | 每实例快照队列消费者数 |
| `SNAPSHOT_REPAIR_INITIAL_DELAY_MS` | 30000 | 启动至第一次快照巡检等待 |
| `SNAPSHOT_REPAIR_INTERVAL_MS` | 60000 | 两轮快照巡检之间的等待 |
| `SEARCH_REPAIR_INTERVAL_MS` | 5000 | 两轮索引巡检之间的等待 |

使用 Compose 时，通过 backend 服务的 `environment` 传入覆盖值。

## 本机验证

- 隔离 MySQL `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify` 通过 468 项，无跳过。覆盖确认前等待、ACK、NACK、超时、mandatory return、发布队列饱和、裁剪边界、消费重试上限和巡检分页。
- `npm --prefix frontend test` 通过 472 项，`npm --prefix frontend run build` 和 `node frontend/scripts/check-initial-bundles.mjs` 通过。
- 在仅含合成账号和文档的 Compose 项目运行 `copage-backend:codi126-verified`。RabbitMQ 管理 API 观测两类队列各两个消费者。暂停该项目的 Elasticsearch，两个独立文档合计收到 40 次 WS 确认，两份 revision 20 快照在最后一次确认后约 300 毫秒可读。操作期间 ES 待处理标记仍保存在 MySQL，快照队列正常确认两个任务。
- 仅裁剪本次创建的隔离文档至 revision 20，再分别发送 revision 20、21 和损坏 JSON。合法边界消息被确认，另两条各入死信一次，操作队列没有重入。解绑本项目的 `doc.op.persist` 后提交独立文档。真实 broker 的 `RETURNED` 在三次尝试后进入故障日志，WS 确认和 MySQL 正文均可用。该路由仍断开时，搜索在 4.97 秒内可见，快照在 7.11 秒内可读。验收后恢复了绑定和 Elasticsearch。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi126-verified` 通过双实例协同烟测和 9 个浏览器用例，Chromium 用例耗时 50.4 秒。随机 Compose 项目的容器、网络和卷已清理。
