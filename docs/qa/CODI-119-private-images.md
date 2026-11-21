# CODI-119 私有图片验证

使用隔离 Docker Compose、两个后端实例和一组独立 MySQL、Redis、MinIO。浏览器的文档和图片均为本次合成资料。

- `node scripts/production-compose-check.mjs --private-image-smoke` 验证鉴权读取字节、跨实例共享与撤权、匿名 API 返回 401、无权账号返回 404、导出 JSON 重新导入，以及配额达到上限时的中文提示。
- `node scripts/production-compose-check.mjs --proxy-smoke --recovery-smoke` 验证 Nginx HTTPS 下鉴权 GET/HEAD、MinIO 匿名对象返回 403，并从同步 SQL 和 MinIO 备份恢复到空卷。恢复后核对图片 SHA-256，所有者和只读成员可读，未授权账号仍被拒绝。搜索也从空索引恢复。
- Orca 的编辑器、命名历史、个人模板和打印预览均实际解码 64 × 64 棋盘格。搜索命中该文档，结果摘要只包含文字。Chrome 的应用打印操作生成了单页 PDF。渲染输出确认棋盘格位于可见页边界内。[编辑器](assets/codi119/editor.png) · [历史版本](assets/codi119/history.png) · [模板](assets/codi119/template.png) · [打印预览](assets/codi119/print.png) · [PDF](assets/codi119/printed.pdf) · [PDF 渲染](assets/codi119/pdf-page.png)
- `mvn verify` 使用独立 MySQL 8.4.3 通过 448 项，迁移测试确认旧文档创建图片关联且保留原正文。`npm test` 通过 458 项，`npm run build` 通过。

两套 Compose 烟测使用本次 Maven JAR 组装的运行时镜像。图片格式校验保留魔数识别与单文件上限，尺寸校验和二次编码未纳入此轮。富文本导出保留引用，跨环境迁移仍需同一时点的数据库和图像文件备份。
