# pi-pretty-tui 临时试用方案

## 用户要求

安装并启用 pi-pretty-tui，临时禁用自研 auto-hide-thinking，保留恢复能力。

## 方案

- 在用户级 Pi 配置安装已审阅的 npm:pi-pretty-tui@0.2.9。
- 在 /Users/jiezhou/.pi/agent/settings.json 的 extensions 中加入精确排除项 -/Users/jiezhou/.pi/agent/extensions/auto-hide-thinking.ts。
- 不删除或移动 /Users/jiezhou/.pi/agent/extensions/auto-hide-thinking.ts 的软链，不改仓库扩展代码或 scripts/link.mjs 清单。
- /Users/jiezhou/.pi/agent/pretty-tui.json 设置 enabled=true、mode=clean。
- 不更改其他扩展或升级 Pi。本机 Pi 1.2.0，第三方声明测试基线 1.3.0，因此加载检查不等同于完整 TUI 兼容性验证。

## 验证与生效

检查安装版本、资源解析结果（自研被排除，第三方被加载）及加载错误。运行仓库软链检查，已有无关漂移只报告不修复。

本窗口现有原型补丁仍在运行；用户完成本轮后执行 /restart 换进程，避免 /reload 遗留原型、闭包、Symbol 状态。实际鼠标、活动树和历史重建效果需要重启后试用。

## 回退

停用或移除 npm:pi-pretty-tui，移除 settings.json 中上述 auto-hide-thinking 排除项，再 /restart。不得整份覆盖 settings.json 以免丢失其他窗口的新配置。
