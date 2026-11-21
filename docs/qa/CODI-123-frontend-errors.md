# CODI-123 前端错误上报验收

`PageBoundary.componentDidCatch`、浏览器 `error` 和 `unhandledrejection` 都使用同一个发送入口。接收端由共页后端运行，无第三方处理服务。登录前也可上报，从 `FRONTEND_ORIGIN` 接收 JSON。开发模式默认关闭，生产默认开启，前后端分别可关闭。

## 数据核对

| 字段 | 内容 |
| --- | --- |
| `source` | `render`、`window` 或 `rejection` |
| `route` | 固定应用路由、`/docs/:id` 或 `other` |
| `kind` | 固定的 JavaScript 异常类别，其他统一为 `unknown` |
| `environment` | `production`、`staging` 或 `development` |
| `release` | 构建注入或 Git 获取的完整 SHA，无版本来源时为 `unknown` |

请求省略授权头、Cookie 和 Referer。发送器不传异常消息、堆栈、完整 URL、查询、片段、文档编号、账号或正文。服务端仅接收这五个字段，拒绝额外字段、非法枚举、重复键及超过 512 字节的请求。通过校验及配额检查后，服务端记录固定字段，复用容器日志轮转。

真实 Chromium 测试在登录页保留合成查询串、Cookie 和含敏感样本的错误消息。三类请求均返回 204。按请求字段、认证头、Cookie、Referer 和后端日志逐项核对，测试样本均未出现在记录中。测试产物显式使用合成 SHA，采样率设为 1。下方为其中一条已实际接收的请求体。

```json
{"source":"render","route":"/login","kind":"TypeError","environment":"production","release":"123456789a123456789a123456789a123456789a"}
```

在浏览器注入渲染异常，页面显示原错误提示。重复触发同类全局错误只收到一条报告。模拟上报网络失败后仍可进入注册表单。 [渲染异常提示](assets/codi123/render-fallback.png)

## 命令与结果

```text
mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify
npm --prefix frontend test
npm --prefix frontend run build
node frontend/scripts/check-initial-bundles.mjs
node scripts/production-compose-check.mjs --frontend-error-smoke --runtime-image=copage-backend:codi123-verified
```

2026-11-22 后端 455 项测试、前端 468 项测试、Vite 构建与分片检查均通过。后端构建使用临时 MySQL 验证迁移。Compose 使用 Maven 构建的 JAR，在双后端随机项目实测合法来源、512 字节边界、拒绝无关字段、共同 Redis 配额及后端开关。关闭接收后返回 404。隔离烟测退出码为 0，临时栈与数据卷已清理。

采样可能漏掉低频异常。页面开始执行脚本前的失败及已由业务流程处理的错误没有进入这些全局监听器。未测试默认 Dockerfile 的源码构建、外部日志平台、实际公网或浏览器进程崩溃。
