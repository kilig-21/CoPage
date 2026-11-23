# CODI-203 文档内查找复验

同一篇 36 段长文档有三处「整理关键字」。使用真实 Chrome 和本地两种身份，比较打开默认查找后首处匹配。面板下方空间按视口高减去面板底边计算。最终测量在同步状态就绪后采样。

| 视口 | 所有者下方空间 | 只读协作者下方空间 | 证据 |
| --- | --- | --- | --- |
| 1280×850 | 495 → 588px | 415 → 588px | [桌面改前](assets/codi203/owner-before-1280.png) · [桌面改后](assets/codi203/owner-after-1280.png) |
| 320×640 | 130 → 396px | 107 → 396px | [所有者改前](assets/codi203/owner-before-320.png) · [所有者改后](assets/codi203/owner-after-320.png) · [只读改前](assets/codi203/reader-before-320.png) · [只读改后](assets/codi203/reader-after-320.png) |
| 320×480 | 80 → 236px | 80 → 236px | [只读改前](assets/codi203/reader-before-320x480.png) · [只读改后](assets/codi203/reader-after-320x480.png) |

320px 默认面板高 114px，匹配导航和大小写开关均为 44px。首处及第二处匹配的真实高亮均在面板下方和视口内。查找框按 Enter 和 Shift+Enter 切换匹配，结果为零时禁用导航。只读正文保留 `aria-readonly=true` 与状态栏提示，查找只显示可用操作。

所有者在两档用 Ctrl+F 打开查找，主动展开替换后聚焦替换输入，收起再展开时保留查找词和已输入的替换文字。隔离浏览器断线时替换禁用，连回后用 UI 实际替换一处，两份副本均保存为修订 1，刷新后可读到替换词。编辑者按 Esc 回正文，只读成员按 Esc 回查找按钮。

[窄屏无匹配](assets/codi203/empty-320.png) · [窄屏断线](assets/codi203/replace-unavailable-320.png) · [窄屏替换已保存](assets/codi203/replace-saved-320.png)

本轮未执行全部替换。实体手机软键盘、真实系统输入法、其他浏览器和读屏器未覆盖。
