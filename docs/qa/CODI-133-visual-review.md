# CODI-133 视觉基础复核

基线为 `cb097db`。使用 Orca 浏览器打开生产构建，连接隔离 Docker Compose 中的真实 API、搜索和 WebSocket。页面只含本轮合成资料。

## 视觉规范

- [theme.js](../../frontend/src/styles/theme.js) 提供 Ant Design 与 CSS 的共同色板、15px 正文、10px 面板圆角和 38px 标准控件。页面使用纸白，卡片使用浅纸白，操作使用蓝色，成功、警告和错误保留独立语义色。
- [design-system.css](../../frontend/src/styles/design-system.css) 统一 28～38px 页标题、24px 区域标题、16px 列表标题、13px 辅助文字和 1.65 正文行高。常规间距为 4、8、12、16、24、32、48、64px。桌面内容两侧各留 32px，窄屏为 16px，主要移动操作保留 44px 点击区。
- [ListEmptyState.jsx](../../frontend/src/components/ListEmptyState.jsx) 用同一枚文档图标和一段页面专属提示表现空列表。图标对辅助技术隐藏。使用 Ant Design 的加载遮罩展示正在加载或搜索，错误沿用各页面已有说明和重试入口。

## 真实浏览器截图

截图对应 900px 高的浏览器视口。出现浏览器滚动条时，图像实际宽度会减少约 15px。[360、768、1024、1440px 前后对照原图](assets/codi133/other-viewports.zip) 包含另外 80 张截图。

| 页面 | 1280px | 320px |
| --- | --- | --- |
| 登录 | [改前](assets/codi133/before/login-1280.jpg) · [改后](assets/codi133/after/login-1280.jpg) | [改前](assets/codi133/before/login-320.jpg) · [改后](assets/codi133/after/login-320.jpg) |
| 工作台 | [改前](assets/codi133/before/home-1280.jpg) · [改后](assets/codi133/after/home-1280.jpg) | [改前](assets/codi133/before/home-320.jpg) · [改后](assets/codi133/after/home-320.jpg) |
| 我的文档 | [改前](assets/codi133/before/documents-1280.jpg) · [改后](assets/codi133/after/documents-1280.jpg) | [改前](assets/codi133/before/documents-320.jpg) · [改后](assets/codi133/after/documents-320.jpg) |
| 编辑器 | [改前](assets/codi133/before/editor-1280.jpg) · [改后](assets/codi133/after/editor-1280.jpg) | [改前](assets/codi133/before/editor-320.jpg) · [改后](assets/codi133/after/editor-320.jpg) |
| 搜索 | [改前](assets/codi133/before/search-1280.jpg) · [改后](assets/codi133/after/search-1280.jpg) | [改前](assets/codi133/before/search-320.jpg) · [改后](assets/codi133/after/search-320.jpg) |
| 模板中心 | [改前](assets/codi133/before/templates-1280.jpg) · [改后](assets/codi133/after/templates-1280.jpg) | [改前](assets/codi133/before/templates-320.jpg) · [改后](assets/codi133/after/templates-320.jpg) |
| 小组 | [改前](assets/codi133/before/groups-1280.jpg) · [改后](assets/codi133/after/groups-1280.jpg) | [改前](assets/codi133/before/groups-320.jpg) · [改后](assets/codi133/after/groups-320.jpg) |
| 项目 | [改前](assets/codi133/before/projects-1280.jpg) · [改后](assets/codi133/after/projects-1280.jpg) | [改前](assets/codi133/before/projects-320.jpg) · [改后](assets/codi133/after/projects-320.jpg) |
| 回收站 | [改前](assets/codi133/before/trash-1280.jpg) · [改后](assets/codi133/after/trash-1280.jpg) | [改前](assets/codi133/before/trash-320.jpg) · [改后](assets/codi133/after/trash-320.jpg) |
| 账号 | [改前](assets/codi133/before/account-1280.jpg) · [改后](assets/codi133/after/account-1280.jpg) | [改前](assets/codi133/before/account-320.jpg) · [改后](assets/codi133/after/account-320.jpg) |

## 验证记录

- 十页在 320、360、768、1024、1280、1440px 的 60 组改后测量均满足 `documentElement.scrollWidth === documentElement.clientWidth`。窄屏导航仍可独立横向滚动。[改前测量](assets/codi133/before/viewport-metrics.json) · [改后测量](assets/codi133/after/viewport-metrics.json)
- 搜索页在 320px 下实际按 Tab 显示跳转链接焦点，Enter 将焦点移入主内容。减弱动效时导航过渡缩至 0.01ms。空状态图标对读屏隐藏，搜索按钮实测 47.5px 高。[浏览器测量](assets/codi133/interaction.json)
- 暂停隔离后端后，实际搜索显示“正在搜索”，加载区有 `aria-live="polite"`。恢复后端即返回合成的周会纪要。[320px 加载态](assets/codi133/search-loading-320.jpg)
- `mvn --batch-mode --no-transfer-progress -f backend/pom.xml verify` 在独立 MySQL 8.4.3 实例中通过 417 项，含 9 项数据库验证。
- `npm --prefix frontend test` 通过 453 项，新增色板同步与主要文本对比度测试。`npm --prefix frontend run build` 通过。

负责人确认画面后完成视觉验收。浏览器为 Orca 内嵌 Chromium，实机触屏、系统读屏器和全站所有警告或禁用态的对比度留待专项验证。
