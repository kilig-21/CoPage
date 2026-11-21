# CODI-121 使用指南按需加载验收

九处静态引入已收敛到一个动态入口。登录、工作台和编辑器都在打开指南时才请求对应模块。小组、项目、私人模板和编辑器仍打开各自的默认章节。指南沿用原来的 Ant Design Drawer 和 Collapse，保留抽屉样式、折叠行为和键盘操作。原指南分片的大部分 Ant Design 代码也由页面上的组件使用，继续采用现有组件可保留交互一致性。

## 构建对比

使用相同的 Node `24.16.0`、锁文件和本地后端地址。基线为 `e5ff76f`。按 Vite manifest 去重相加入口与相应页面的静态 JavaScript 依赖，报告每个文件单独 gzip 后的字节总数。

| 页面 | 修改前 gzip B | 修改后 gzip B | 减少 B |
| --- | ---: | ---: | ---: |
| 登录 | 263,277 | 248,546 | 14,731 |
| 工作台 | 330,933 | 322,064 | 8,869 |
| 编辑器 | 440,461 | 431,859 | 8,602 |

原指南共用分片为 105,076 B gzip，其中部分代码仍是页面所需的依赖。新动态的 `UserGuide` 分片为 11,548 B gzip，指南首次打开时还会加载可折叠面板所需的分片。`frontend/scripts/check-initial-bundles.mjs` 从产物检查所有懒加载页面，无须依赖文件名中的哈希。该脚本接受基线目录进行对比，直接以旧静态产物运行时会按预期报错。CI 的前端构建后已接入此检查。

```text
mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify
npm --prefix frontend test
npm --prefix frontend run build
node frontend/scripts/check-initial-bundles.mjs frontend/dist <baseline-dist>
```

2026-11-22 通过后端 451 项测试、前端 458 项测试、Vite 构建以及所有页面的产物检查。隔离 MySQL 执行了迁移测试。

## Orca 浏览器验证

- 登录页、工作台和合成文档的编辑页首次打开时，浏览器 Resource Timing 中指南分片均为 0 次。登录和工作台按 Enter 打开后各出现 1 次请求。
- 登录页按 Enter 后焦点进入指南，Tab 可到达章节，Enter 切换章节，Escape 关闭并将焦点还给指南入口。工作台和编辑器使用同样的回焦方式，编辑器回到“更多文档操作”。小组和编辑器打开相应默认章节。 [登录](assets/codi121/login-guide.png) · [工作台](assets/codi121/workbench-guide.png)
- 隔离静态服务让指南分片延迟 9 秒，登录表单保留。按 Escape 取消并回焦，分片随后完成也不重新打开。 [加载中](assets/codi121/login-guide-loading.png)
- 在 Orca 拦截指南分片，错误提示留在当前登录页，表单仍可用。Esc 可关闭提示并回焦。分片请求失败后需要重新加载页面再取。 [加载失败](assets/codi121/login-guide-unavailable.png)

测量使用本地生产构建。慢请求与网络失败都在本地注入，未测公网传输时间或实体读屏器。
