# CODI-124 Playwright 本地端到端冒烟

## 运行

需要项目约定的 Node、Docker Compose 和可下载依赖的网络。首次安装依赖和浏览器，之后使用第三条命令运行。

```text
npm --prefix frontend ci
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
```

命令创建随机 Compose 项目、隔离卷、动态回环端口和临时生产前端产物。测试账号、文档和上传内容均为合成数据。测试使用启动守卫的本地配置，后端仍校验回环前端来源。默认从仓库 Dockerfile 构建后端，退出时核对项目标签后清理临时容器、网络、卷和前端产物。常规开发环境无需停机。可选 `COPAGE_E2E_BROWSER_CHANNEL=chrome` 使用本机 Chrome。离线条件下已有对应的非 root 后端镜像时，可显式传入 `-- --runtime-image=copage-backend:<tag>`。

## 覆盖

1. 真实登录后登出，再打开受保护的文档列表应回到登录页。
2. 在文档列表建立新文档，输入文字并触发 Quill 的组合输入事件，刷新后读取已保存正文。
3. 两个隔离账号用各自浏览器会话协作。一条操作被测试路由有意截留，再进入离线并关闭原标签。重新联网和显式恢复后，真实 WebSocket 将保存的草稿同步给两端。
4. 预览旧正文并恢复，核对恢复产生的新版本及刷新后的正文。
5. 搜索只出现在正文里的关键词，进入命中的文档。
6. 从列表删除文档，回收站恢复后打开同一个编号并核对正文。
7. 校验打印预览的正文，触发真实浏览器下载，解析 CoPage 富文本副本并从文件导入新文档。

组合输入用浏览器的 `CompositionEvent` 与 Quill DOM 近似。系统输入法的候选框、平台事件顺序、实体移动端及真实打印窗口仍需单独验证。协作测试用 API 准备第二账号的文档权限，其余编辑、恢复和同步走页面入口。离线场景只截留指定阶段的写操作，正常协作和恢复不转用模拟服务。

## 失败定位和新增用例

从 `frontend/test-results/e2e/` 查看失败截图、DOM 快照和 `trace.zip`，可用 `npm --prefix frontend exec -- playwright show-trace <trace.zip>` 打开。GitHub Actions 的 `Chromium end-to-end smoke` 作业在 push 和 PR 执行此命令，失败附件包含截图和 trace，上传前移除合成密码与 JWT。诊断文件不要提交到仓库。

新增场景时，在 `frontend/e2e/` 使用真实可访问名称和等待条件。账号由用例在隔离栈注册，通过页面正常登录。业务数据只写该用例创建的文档。模拟只用于复现实在不易触发的故障，并注明截留或改写的边界。

现有 `scripts/*-smoke.mjs` 仍保留。它们继续核对协议边界、双后端、健康探针、备份恢复、数据迁移和服务故障。Playwright 增加页面操作、浏览器会话、编辑器 DOM 和文件下载证据。

## 本机验证记录

2026-11-22 使用 `COPAGE_E2E_BROWSER_CHANNEL=chrome` 运行 `npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi123-verified`。隔离双实例的通用协作烟测确认了 30 次并发提交，七条 Chromium 浏览器用例全部通过，用例阶段耗时 31.4 秒。真实导出文件经解析和再次上传。曾以失败 trace 核对定位问题和凭据脱敏，脱敏后压缩包仍可读取。 [仅正文关键词的搜索命中](assets/codi124/search-result.png)

同轮隔离 MySQL 的 Maven verify 通过 455 项测试，前端通过 468 项测试，Vite 构建与静态分片检查通过。本机浏览器烟测使用当前代码构建的非 root JAR 镜像。默认源码构建由 CI 作业单独执行。
