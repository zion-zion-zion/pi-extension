# pi-extension

我使用 [pi](https://github.com/earendil-works/pi-coding-agent) 时写的一些扩展插件（extensions），公开分享。

## 插件列表

| 文件 | 功能 |
|------|------|
| [`extensions/commits.ts`](extensions/commits.ts) | `/commits` — 用列表查看当前分支提交历史，选中后 `git show --stat` 查看详情 |
| [`extensions/checkpoint.ts`](extensions/checkpoint.ts) | `/checkpoint` — 自动生成提交信息并提交当前 git 改动（绝不 push） |
| [`extensions/token-speed.ts`](extensions/token-speed.ts) | 显示上一条回答的 token 生成速度（tok/s），通过 pi-footer 的 widget 展示；`/speed` 查看详细统计 |
| [`extensions/startup-sync.ts`](extensions/startup-sync.ts) | 启动时自动同步 pi 配置仓库（双向提交 + fetch/rebase + push）。⚠️ 与本机备份脚本 `scripts/backup.sh` 强耦合，属于个人环境专用 |
| [`extensions/steer-or-interrupt.ts`](extensions/steer-or-interrupt.ts) | Opt+Enter：没有进行中的 tool 时立刻中断当前回答并发送；有挂起的 tool 时走内置 steering |
| [`extensions/auto-hide-thinking.ts`](extensions/auto-hide-thinking.ts) | Herdr 下联动显示/隐藏 thinking 与完整工具块：生成中可见，整轮结束后收起；`Ctrl+T` 恢复两者，`Ctrl+O` 仍只控制工具展开。只在 Herdr pane 生效 |
| [`extensions/reload-all/`](extensions/reload-all/) | `/reload-all` — 把 Herdr 里所有空闲的 pi 窗口重载一遍；跳过忙碌或输入框里有未提交草稿的窗口 |
| [`extensions/codex-usage/`](extensions/codex-usage/) | `/status` 查看 ChatGPT Codex 的 5 小时 / 周额度，底部状态栏常驻摘要；复用 pi 管理的 `openai-codex` OAuth |
| [`extensions/model-filter.ts`](extensions/model-filter.ts) | 隐藏内置 provider 里用不到的历史模型（默认过滤 `openai-codex` 的 gpt-5.3~5.5），在 `/model` 与 `--list-models` 生效 |
| [`extensions/pi-footer.json`](extensions/pi-footer.json) | pi 底部状态栏（footer）配置：布局、图标、widget 等 |
| [`extensions/pi-context-view.json`](extensions/pi-context-view.json) | 「Context View」颜色主题配置（各消息类型的颜色） |

## Skills

| 文件 | 功能 |
|------|------|
| [`skills/read-terminal/`](skills/read-terminal/) | 按需读取 Herdr 里另一个命名终端 pane 的屏幕 / scrollback。只在 Herdr 环境下生效，纯读取，不会向对方 pane 写入 |

## 安装

把需要的 `.ts` 文件复制到全局扩展目录，然后重启 pi 或在 pi 内执行 `/reload` 热加载：

```bash
# 以 commits.ts 为例
cp extensions/commits.ts ~/.pi/agent/extensions/
# 在 pi 里执行 /reload
```

也可以直接把这个仓库克隆下来，用软链接指向扩展目录：

```bash
git clone https://github.com/zion-zion-zion/pi-extension.git
ln -s "$PWD/pi-extension/extensions" ~/.pi/agent/extensions-local
```

`codex-usage` 是目录型扩展，需要把整个目录放到扩展路径下：

```bash
cp -R extensions/codex-usage ~/.pi/agent/extensions/
# 或软链接
ln -s "$PWD/pi-extension/extensions/codex-usage" ~/.pi/agent/extensions/codex-usage
```

Skill 放到全局 skill 目录即可被 pi 发现：

```bash
cp -R skills/read-terminal ~/.agents/skills/
# 或软链接
ln -s "$PWD/pi-extension/skills/read-terminal" ~/.agents/skills/read-terminal
```

> 放置路径：全局 `~/.pi/agent/extensions/`，项目级 `.pi/extensions/`（需先信任项目）。快速测试可用 `pi -e ./xxx.ts`。Skill 路径：全局 `~/.agents/skills/` 或 `~/.pi/agent/skills/`。
>
> 安全提示：扩展和 skill 都以你的完整权限运行，只从可信来源安装。

## 依赖

`.ts` 扩展会 import pi 的官方包，pi 自带，无需额外安装：

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`

## 说明

- 目录里没有 `herdr-agent-state.ts`：该文件由 [herdr](https://github.com/ezra-herdr/herdr) 自动生成并管理，重装集成会被覆盖，不适合公开分发。
- `auto-hide-thinking.ts` 只在 Herdr 的 TUI pane 里生效：读 `settings.json` 的 `hideThinkingBlock`，不一致时用 `herdr pane send-keys` 注入 `Ctrl+T`；thinking 隐藏时，Bash、Read、Edit 等工具块整体不渲染。`Ctrl+T` 会同时恢复 thinking 和工具块，`Ctrl+O` 仍只切换工具块内部的预览/完整输出。非 Herdr / print / RPC 模式直接空操作。
- 这些插件来自我的个人配置，部分（如 `startup-sync.ts`）与我的本机环境耦合，仅供参考，按需裁剪。
