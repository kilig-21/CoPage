# CODI-217 查找输入提示的对比度

使用 Chrome 158 的 1280×850 和 320×640 视口，读取未填值输入的实际 `::placeholder` 样式、透明度和底色。按相对亮度计算对比度。普通提示文字的目标为 4.5∶1。 [W3C 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

| 两档实测 | 改前 | 改后 |
| --- | --- | --- |
| 搜索、文档筛选、模板、回收站、文档内查找 | 25% 黑叠在 `#fffefa`，1.833∶1 | 辅助文字色 `#5c6572`，5.846∶1 |
| 实际输入文字 | 13.958∶1 | 13.958∶1 |

- [窄屏搜索改前](assets/codi217/before-search-320.png) · [改后](assets/codi217/after-search-320.png)
- [桌面文档筛选改前](assets/codi217/before-documents-1280.png) · [改后](assets/codi217/after-documents-1280.png)
- [窄屏编辑器查找改前](assets/codi217/before-editor-320.png) · [改后](assets/codi217/after-editor-320.png)

真实 Chrome 在两档使用键盘提交查询，复验列表和搜索的预览等待、一次注入 503 后重试、真实结果、文档查找空态、匹配、Esc 回到正文焦点，以及空回收站。各页面无横向溢出。

对生产构建运行窄屏导航、模板、编辑器查找、正文检索和回收站的 5 项 Chrome 回归，全部通过。前端 482 项测试、lint 和 Vite 构建通过。未覆盖其他浏览器、物理触屏、读屏器和系统强制色模式。
