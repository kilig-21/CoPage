# CODI-186 可见文档读取实测

## 样本与方法

在独立 Compose 项目中使用 MySQL 8.4.3。固定 100,037 篇合成文档和同一个演示账号，账号可见 36 篇自有文档、18 篇共享文档。附加样例包含软删除、自有文档的遗留自授权、两种共享权限、相同更新时间以及标题里的字面 `%_`。背景数据关闭检索待同步，测量期间使用相同的 MySQL、Redis 与其他依赖容器。

基线运行原后端镜像 `copage-backend:codi129-verified`。测后以同一镜像为基础替换 Maven 构建的 JAR，只重建基准项目后端。Flyway 在同一份数据上应用 V9。每个场景先顺序预热 10 次，再顺序发起 40 次请求，延迟从本机 HTTP 请求开始计到 JSON 解析完成。p50 和 p95 用样本最近秩计算，单位为毫秒。

| 路径 | 改前 p50 / p95 | 改后 p50 / p95 |
| --- | ---: | ---: |
| `/api/doc/workbench` | 135.26 / 153.46 | 7.92 / 33.54 |
| `/api/doc/list?scope=all&page=1&size=20` | 146.96 / 172.64 | 6.70 / 49.03 |
| `/api/doc/list?scope=shared&page=1&size=20` | 151.30 / 172.34 | 6.54 / 31.11 |
| `/api/doc/list?scope=owned&page=2&size=20&keyword=%25_` | 5.07 / 16.23 | 6.24 / 10.01 |

四条路径的改前改后 JSON 数据 SHA-256 分别一致。已处于低毫秒级的自有文档字面筛选，本次 p50 增加 1.17 ms，p95 减少 6.22 ms。单客户端、回环网络，有效数据集只覆盖当前账号可见 54 篇的场景。

## 执行计划与回归

改前全量可见计数和最近摘要的 `EXPLAIN ANALYZE` 均扫描 `document` 的 100,037 行。改后所有者分支从 `idx_document_owner` 读取 37 行，授权分支从 20 条授权中读取目标文档主键，过滤掉自授权与已删除的条目。授权计数使用新的 `idx_doc_collaborator_user_doc`，最近摘要在这个 20 行授权样本中对授权表使用小表扫描。摘要最终对 54 条可见候选排序。

真实 MySQL 集成测试覆盖自有与共享过滤、软删除、权限值、`%_` 字面匹配和更新时间相同的分页顺序。迁移测试覆盖从空库、旧环境数据库初始化脚本及备份携带的旧表迁移。基准库也实测从 V8 到 V9，四条接口的响应保持一致。

使用新后端的隔离演示库，Chrome 在 1280px 和 320px 验证工作台共享计数、文档列表的共享分类、字面标题筛选和清除。协作者看不到私有样例。另用新账号验证真实空列表，并延迟和截留列表请求以复验加载、失败和重试。 [桌面工作台](assets/codi186/bench-preview-home-1280.png) · [窄屏工作台](assets/codi186/bench-preview-home-320.png) · [桌面共享列表](assets/codi186/bench-preview-shared-1280.png) · [窄屏共享列表](assets/codi186/bench-preview-shared-320.png)

复测时从同一合成数据库分别运行旧 JAR 和新 JAR。上表各路径使用同一登录账号，通过同一回环端口取样。长时间并发负载、多租户授权表规模变化和公网链路另需对应测试环境。

[改前 HTTP](assets/codi186/baseline.json) · [改后 HTTP](assets/codi186/after.json) · [改前执行计划](assets/codi186/plans-before.txt) · [改后执行计划](assets/codi186/plans-after.txt)
