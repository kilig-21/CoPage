# CODI-130 OT 属性测试

保留种子 `20260915` 原有 10,000 组并发编辑。种子 `20261122` 增加 20,000 组带格式的并发编辑，每组以两种优先级分别验证，两条应用路径必须得到相同的正文和属性，共 50,000 次随机 TP1 核对。扩展生成器覆盖带一到两个属性的文本、段落换行和图片插入，也覆盖 retain 属性修改与 `null` 移除。属性取值包含字符串、整数和布尔值。失败输出种子、组号、优先级、基准和两项操作。

确定性用例覆盖同位置带格式插入、颜色与样式移除多键冲突、图片宽度与替代文本、标题级别冲突，以及不同操作分段归一化后的结果。协议说明明确对象型 retain 返回 `400`，整数 retain 可修改已有图片的属性，并说明 Java 与 `quill-delta` 的构造差异及 TP1 的适用范围。 [接口约定](../接口约定.md#ot-格式与收敛范围)

## 本机验证

- `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify` 连接隔离 MySQL 和 Redis，483 项通过且无跳过。WebSocket Handler 测试确认对象型 retain 在调用版本服务前被拒绝。
- `npm --prefix frontend test` 478 项、`npm --prefix frontend run lint`、`npm --prefix frontend run build` 和首屏依赖检查通过。
- `COPAGE_E2E_BROWSER_CHANNEL=chrome npm --prefix frontend run test:e2e -- --runtime-image=copage-backend:codi129-verified` 双实例烟测和 11 条 Chromium 回归通过，临时资源已清理。新用例在真实浏览器的独立 WebSocket 中发送对象型 retain，收到 `400` 后核对 revision 仍为 `0`，随后通过编辑器成功保存正常编辑。生产实现沿用 CODI-129 的已构建镜像，本项仅增加测试和协议文档。
