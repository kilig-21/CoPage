# CODI-200 个人模板键盘复验

在隔离预览用 Chrome 检查 1280×850 与 320×850，启用减弱动效。测试账号有两份真实保存的合成模板，按共同关键词筛出这两条。改前两个预览按钮同名，模板标题输入框内按 Esc 后，焦点落到页面主体。

| 场景 | 两档结果 | 证据 |
| --- | --- | --- |
| 在列表辨认操作 | 预览和删除的可访问名称包含对应模板名称。关掉第一条预览后，Tab 依次经过该条删除按钮和下一条预览按钮。 | [桌面改前](assets/codi200/rows-before-1280.png) · [桌面改后](assets/codi200/rows-after-1280.png) · [窄屏改前](assets/codi200/rows-before-320.png) · [窄屏改后](assets/codi200/rows-after-320.png) |
| 关闭预览 | 内容已加载时按 Esc、候选请求仍挂起时按 Esc、用键盘按底部「关闭」，焦点均回到对应的预览按钮。 | 真实 Chrome 焦点与 Tab 顺序断言 |
| 内容读取失败 | 浏览器拦截详情请求并返回 HTTP 503。激活「重新读取模板」后真实后端返回原标题与保存的正文。 | [桌面](assets/codi200/preview-error-1280.png) · [窄屏](assets/codi200/preview-error-320.png) |
| 取消删除 | 确认框显示所选名称。键盘取消后模板仍在列表，焦点回到对应的删除按钮。 | [桌面](assets/codi200/cancel-focus-1280.png) · [窄屏](assets/codi200/cancel-focus-320.png) |
| 长名称 | 152 字符模板名称可换行，两档页面均无横向溢出。 | [桌面](assets/codi200/long-name-1280.png) · [窄屏](assets/codi200/long-name-320.png) |

生产构建 E2E 持续覆盖两档的行操作命名、预览 Esc 回焦和取消删除回焦。此次未执行实际删除，读屏器、实体手机和其他浏览器未覆盖。
