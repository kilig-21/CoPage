# CODI-117 登出与 WebSocket 验证

隔离 Compose 的两个后端连接同一组 MySQL 与 Redis。使用独立的合成账号登录两次，Cookie 和浏览器真实凭据均未进入证据。

- `node scripts/production-compose-check.mjs --session-revocation-smoke` 验证两个令牌不同。实例 A 登出后，实例 B 上尚未加入文档的旧 WebSocket 收到 1008，旧令牌在 B 的 HTTP 和新握手均返回 401。另一枚令牌仍通过校验。Redis 撤销键的毫秒 TTL 为正且不超过令牌期限。
- 修改合成账号密码后，其余旧连接关闭，旧令牌被两种入口拒绝。重新登录可建立协同连接。有效握手协商 `copage.v1`，浏览器发起的 WebSocket URL 无查询参数。
- Orca 加载了生产构建，在隔离本地项目打开合成文档并看到“已连接”。随后在工作台点击退出。在线截图显示退出已确认。浏览器离线场景仍回到登录页，并提示服务端撤销未确认。两次测量都确认本地令牌已清除。[在线](assets/codi117/confirmed.png) · [离线](assets/codi117/offline.png)
- `mvn verify` 在真实隔离 MySQL 下通过 447 项，`npm test` 通过 456 项，`npm run build` 通过，恢复通道诊断测试 7 项通过。受保护接口与前端行为的回归测试会由现有 CI 命令执行。

烟测通过本次 Maven JAR 组装的运行时镜像进行。公网代理和 Redis 异常掉电后的撤销记录持久性留待验证。
