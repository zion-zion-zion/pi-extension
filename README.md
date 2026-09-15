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
| [`extensions/scroll-to-last-prompt.ts`](extensions/scroll-to-last-prompt.ts) | 每轮回复结束后，自动把「我上一条消息」的第一行顶到屏幕顶部，方便从头顺序读本轮回复；生成中手动上翻过则不打扰，下次发送消息自动恢复跟随。只在 fullscreen TUI 生效 |
| [`extensions/reload-all/`](extensions/reload-all/) | `/reload-all` 把 Herdr 里所有空闲的 pi 窗口重载一遍；`/restart-all` 把它们**重启**一遍（换进程、各自回到自己的对话）。两者都跳过忙碌 / 输入框里有草稿的窗口 |
| [`extensions/restart.ts`](extensions/restart.ts) | `/restart` — 重启**本窗口**（换进程，回到同一个对话）。`/reload` 只换扩展代码、不换进程，清不掉内存里被污染的状态时用它。只在 Herdr pane 生效 |
| [`extensions/codex-usage/`](extensions/codex-usage/) | `/status` 查看 ChatGPT Codex 的 5 小时 / 周额度，底部状态栏常驻摘要；复用 pi 管理的 `openai-codex` OAuth |
| [`extensions/model-filter.ts`](extensions/model-filter.ts) | 隐藏内置 provider 里用不到的历史模型（默认过滤 `openai-codex` 的 gpt-5.3~5.5），在 `/model` 与 `--list-models` 生效 |
| [`extensions/pi-footer.json`](extensions/pi-footer.json) | pi 底部状态栏（footer）配置：布局、图标、widget 等 |
| [`extensions/pi-context-view.json`](extensions/pi-context-view.json) | 「Context View」颜色主题配置（各消息类型的颜色） |

## Skills

| 文件 | 功能 |
|------|------|
| [`skills/read-terminal/`](skills/read-terminal/) | 按需读取 Herdr 里另一个命名终端 pane 的屏幕 / scrollback。只在 Herdr 环境下生效，纯读取，不会向对方 pane 写入 |

## 安装

### 方式一：pi 包安装（推荐）

整个仓库已发布为 pi 包，一条命令装全部扩展和 skill：

```bash
pi install npm:@zionzionzion/pi-extensions
```

- 装的内容：`extensions/` 下全部扩展 + `skills/read-terminal`
- 更新：`pi update npm:@zionzionzion/pi-extensions`（或 `pi update --extensions` 一并更新所有包）
- 卸载：`pi remove npm:@zionzionzion/pi-extensions`
- 只想启用其中部分：`pi config` 里按需开关，或在 `settings.json` 里用 package 过滤（见 pi 文档的 Package Filtering）

> ⚠️ 如果之前手动复制过扩展到 `~/.pi/agent/extensions/`，装包前先删掉对应副本，否则会双加载。`pi-context-view.json` / `pi-footer.json` 是配置文件不是扩展，不随包分发，留在原处即可。

### 方式二：手动复制（按需挑选）

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
> **复制 vs 软链，选软链**：`cp` 出来的是一份**拷贝**，以后改仓库里的源码不会生效（仓库和 pi 加载的那份会静默漂移）；`ln -s` 的是**同一个文件**，改仓库等于改 pi 正在加载的代码。所以「仓库是唯一真源」只在软链下成立。
>
> 安全提示：扩展和 skill 都以你的完整权限运行，只从可信来源安装。

## 发布

npm 包由 GitHub Actions 自动发布：只要 `package.json` 的 `version` 变化并 push 到 `main`，CI 就会跑测试 → `npm publish` → 自动打 `v*` tag；版本号没变的 push 只跑测试，不会发版。

```bash
npm version patch   # 或 minor / major
git push            # 之后全自动，无需手动 npm publish
```

CI 定义见 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)。

## 依赖

`.ts` 扩展会 import pi 的官方包，pi 自带，无需额外安装：

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`

## 说明

- 目录里没有 `herdr-agent-state.ts`：该文件由 [herdr](https://github.com/ezra-herdr/herdr) 自动生成并管理，重装集成会被覆盖，不适合公开分发。
- `auto-hide-thinking.ts` 只在 Herdr 的 TUI pane 里生效：拿**本 pane 自己的** `hideThinkingBlock` 当基准（`settings.json` 被所有 pane 共享，只能当兑底，不能用来判定“已经是目标值”），不一致时用 `herdr pane send-keys` 注入 `Ctrl+T`；thinking 隐藏时，Bash、Read、Edit 等工具块整体不渲染。`Ctrl+T` 会同时恢复 thinking 和工具块，`Ctrl+O` 仍只切换工具块内部的预览/完整输出。非 Herdr / print / RPC 模式直接空操作。
- `restart.ts`（`/restart`）与 `reload-all/`（`/reload-all`、`/restart-all`）**互不依赖**，可以单独安装、单独升级。`/restart` 靠一个几行的 `/bin/sh` 分离助手在自己的 pi 退出后再把窗口拉起来（`pi --session <原会话文件>`），助手日志在 `~/.pi/agent/restart.log`；`/restart-all` 只重启「空闲 + 输入框为空 + Herdr 记着会话」的其他窗口，每个窗口任一步失败就跳过它，**绝不**往别人输入框里灌文本。
- **`/restart` 在「让新东西生效」这件事上覆盖 `/reload`**（换进程后扩展 / skills / prompts / themes / keybindings / context 文件全部重读，并且额外重读 `models.json`、环境变量，用上升级后的 pi 本体，清掉原型/闭包里的脏状态——包括那些 `session_start` 时快照下来、`/reload` 刷不掉的参数）。代价是几秒黑屏，且会丢展开的工具块 / 滚动位置这类内存态。选型：
  - 只改了扩展代码、想快速看效果 → `/reload` / `/reload-all`（亚秒级、不闪屏）
  - 改了 `models.json` / 环境变量、升级了 pi、或怀疑内存里有脏状态 → `/restart` / `/restart-all`
  - 拿不准 → `/restart`：除了慢几秒，它不会有「半新半旧」这种不确定性
  - 一个真实的能力差：`/restart-all` 会跳过「Herdr 还没记录会话」的窗口（刚开、没发过消息的），那种窗口只有 `/reload-all` 能覆盖
- 这些插件来自我的个人配置，部分（如 `startup-sync.ts`）与我的本机环境耦合，仅供参考，按需裁剪。
- `scroll-to-last-prompt.ts` 只在 `tuiMode: "fullscreen"` 下生效。它给 `UserMessageComponent` 渲染后的首行打标记来精确命中「我上一条消息」，而不是扫 pi 内置的 `OSC 133;A`——助手那条没有工具调用的纯文本消息也会带同样的前缀，只扫标记会定位成回复开头。滚动会让 ScrollView 退出「跟随最新」，所以下一次发送消息时（`alt+enter` 排队的消息除外）自动恢复跟随。
