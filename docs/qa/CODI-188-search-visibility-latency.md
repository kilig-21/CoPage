# CODI-188 搜索可见范围实测

## 同一场景的 HTTP 对照

在独立 Compose 中复用 CODI-186 的 100,037 篇合成文档和 MySQL 8.4.3。testA 可见 36 篇自有文档、18 篇共享文档。测试包含软删除、遗留的所有者自授权，以及由另一账号所有、同样匹配 `owned` 的私有文档。Elasticsearch 8.15.3 同步了这些相关文档，合成背景文档不需要参与命中。测量前确认待同步条数为零，再在同一套 MySQL、Elasticsearch、Redis 和 MQ 上分别运行 CODI-186 与本次构建的 JAR。

各场景先预热 10 次，再用同一台机器顺序发出 40 次 HTTP 请求，计时从发出请求到 JSON 解析完成。p50 和 p95 使用最近秩，单位毫秒。

| 搜索场景 | 改前 p50 / p95 | 改后 p50 / p95 |
| --- | ---: | ---: |
| 自有标题，第 1 页 | 96.25 / 105.83 | 18.96 / 67.10 |
| 共享标题，第 1 页 | 96.75 / 106.64 | 21.16 / 55.57 |
| 自有标题，第 2 页 | 90.99 / 96.03 | 12.94 / 46.70 |
| 无结果 | 87.82 / 102.37 | 8.46 / 13.87 |

四种场景的 JSON 数据 SHA-256 前后一致。相同关键词下，私有文档的所有者能搜到它，testA 得到零条。共享结果包含只读和可编辑权限，软删除与遗留的所有者自授权均未产生额外命中。

## 执行计划与浏览器

`EXPLAIN ANALYZE` 中，旧查询约 103 ms，扫描 100,037 行文档并对授权索引执行 99,999 次查找。新查询约 0.08 ms，从所有者索引读取 37 行，从协作授权索引读取 20 行并按主键获取相应文档，最终仍返回 54 个可见 ID。搜索返回详情时仍会检查文档和授权的当前状态。

使用独立演示库，在 Chrome 1280px 与 320px 上以两个账号实际搜索「报名」。所有者看到 3 篇，协作账号看到 2 篇且不包含私有的筹备会议。检查了键盘提交与清除、打开搜索结果并返回、空结果、延迟响应时的加载状态、HTTP 503 和真实请求重试。宽度均无横向溢出。 [所有者桌面](assets/codi188/search-permission-testA-1280.png) · [所有者窄屏](assets/codi188/search-permission-testA-320.png) · [协作者桌面](assets/codi188/search-permission-testB-1280.png) · [协作者窄屏](assets/codi188/search-permission-testB-320.png) · [窄屏失败反馈](assets/codi188/search-permission-failure-320.png)

本对照的账号只可访问 54 篇文档，未测单账号持有大量文档、生产网络或多客户端并发。截图使用桌面 Chrome 的视口尺寸模拟，没有覆盖物理手机和其他内核。

[改前 HTTP 样本](assets/codi188/search-before.json) · [改后 HTTP 样本](assets/codi188/search-after.json) · [改前执行计划](assets/codi188/search-plan-before.txt) · [改后执行计划](assets/codi188/search-plan-after.txt)
