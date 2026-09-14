# 每轮结束自动把用户消息顶到屏幕顶部设计

## 目标

pi 的 TUI 在回复结束时停在内容最末尾，用户想读本轮回复得自己往上翻到"我上一条消息"的位置。本扩展在每轮结束时把**本轮用户消息的第一行**直接滚到视口顶部，让用户从屏幕第一行开始顺序读到回复末尾。

原本还有 thinking 过程占位，翻到最底是合理的；现在 `auto-hide-thinking.ts` 会在轮次结束时收起 thinking 与工具块，回复更短，"从我的消息开始读"成为更自然的默认视图。

## 行为

- 仅 `tuiMode: "fullscreen"` 且运行模式为 `tui` 时生效；`regular`、print、RPC 模式空操作。
- `agent_settled`（整轮结束，含 auto-retry / auto-compaction / 排队 follow-up 都处理完）时，把渲染记录里**最后一条用户消息**的第一行滚到视口顶部。通常就是本轮那条；若本轮期间用 `alt+enter` 排队了 follow-up，则是那条排队消息（仍然符合“我上一条消息”）。
- **只在用户当时处于自动跟随时吸附**：若生成期间用户手动往上翻过（`scrollView.isFollowingEnd === false`），本轮不吸附，尊重用户位置。
- 滚动会把 `ScrollView` 切到"不跟随最新"（`followingEnd = false`），因此下一次用户发送消息（`input` 事件且 `streamingBehavior !== "followUp"`）时自动 `scrollToEnd()` 恢复跟随，使用户能看到自己的新消息与流式输出。排队型 follow-up（`alt+enter`）不恢复跟随，避免用户在阅读当前回复时被拽走。
- 若回复比一屏还短（内容不足以把该消息顶到最上），`scrollTo` 会被 clamp 到最底部，此时保持跟随状态、不记录为已吸附。
- 中断（`Esc`）后同样按上述规则吸附，不区分正常结束与否。

## 实现方案

新增独立扩展 `extensions/scroll-to-last-prompt.ts`（不并入 `auto-hide-thinking.ts`：本扩展不依赖 Herdr）。

### 1. 标记"用户消息渲染后的第一行"

从 `@earendil-works/pi-coding-agent` 导入官方导出的 `UserMessageComponent`，包装其 `prototype.render`：调用原方法后把 `lines[0]` 存入 `Set<string>`。

- `UserMessageComponent.render` 会把 `OSC 133;A` 前缀加到 `lines[0]`，所以这一行本身就是"标记消息"。
- 不能只扫 `133;A` 定位用户消息：`AssistantMessageComponent.render` 在**该条消息没有工具调用时**也会加同一个 `133;A` 前缀，纯文本回复的助手消息首行同样命中，会定位成"回复开头"而不是"我的消息"。
- 直接走 `Set` 字符串等价比较是可行的：`Container.render` 把子组件的行数组原样拼接（不复制、不加前缀），而 `UserMessageComponent` 是由 `this.chatContainer.addChild(userComponent)` 直接挂上去的，中间没有加前缀的包装层。

### 2. 取到 TUI 与聊天记录

包装 `InteractiveMode.prototype.handleEvent` 捕获本 pane 的 `InteractiveMode` 实例（与 `auto-hide-thinking.ts` 相同的捕获手法）。实例上已经有：

- `instance.ui`：`createInteractiveTuiReference(() => this.renderer)` 产出的代理，fullscreen 下底层是 `TuiAltScreen`；`ui.mode === "fullscreen"` 用于门禁，`ui.currentLayout`、`ui.requestRender()` 经代理透传。
- `instance.transcriptScrollView`：`createChatViewport()` 创建的 `ScrollView`（`follow: "end"`, `primary: true`）。
- `instance.renderer`：真正的渲染器（fullscreen 下是 `TuiAltScreen`）。它被一个 Proxy 包着当 `ui` 用（`/reload` 或切换模式时会被替换），所以行号不在代理上算，而是拿它 `Object.getPrototypeOf(renderer).doRender` 挂后置钩子（见第 3 步）。

### 3. 吸附

`agent_settled` 时只做「前置判定 + 记下意图」，真正的行号计算放在渲染帧之后：

1. `instance.ui.mode !== "fullscreen"` → 返回。
2. `scrollView = ui.currentLayout?.primaryScrollView ?? instance.transcriptScrollView`，缺失 → 返回。
3. `scrollView.isFollowingEnd !== true` → 返回（方案 A：尊重手动滚动）。
4. 在真实渲染器的 prototype 上挂一次性 `doRender` 后置钩子（`Object.getPrototypeOf(instance.renderer).doRender`），记下 `pending`，然后 `requestRender()` 逼一帧。
5. 每帧渲染完之后（此时 `this.currentLayout` 是刚画完的那一帧）：找 `scrollView === sv` 的 box 取 `scrollContentLines`，从末行往上扫找第一个命中 `Set` 的行号 `row`，`sv.scrollTo(row)`。
6. 落位成功后不立刻收工：内容行数若又变（说明 thinking / 工具块还在被收起）就按新行号重新落位；行数与位置连续两帧不变即认为稳定（`pin:ok`）。整个窗口上限 `PIN_WINDOW_MS = 1200ms` / `PIN_MAX_ATTEMPTS = 20`。
7. `sv.scrollTop !== row`（被 clamp 到末端）→ 内容不足一屏，保持跟随、不算吸附；内容没变却不在位 → 用户接管，让位。

### 3b. 踩过的坑：行号不能在 `agent_settled` 里算（第一版就是错的）

第一版在 `agent_settled` 里直接读 `currentLayout` 算行号，真机日志显示 `pin:ok row=5861 共 6274 行`，但屏幕仍然停在末尾。原因是 `auto-hide-thinking.ts` 在**同一轮 settle** 里收起的是**整个 transcript** 的 thinking 与工具块（不是只收起本轮），于是：

- 6274 行里第 5861 行是用户消息（收起前）；
- 收起后所有块消失，同一行掉到很靠前的位置，而 `scrollTop` 还是 5861；
- 下一帧 `ScrollView.updateLayout()` 把它 clamp 回 `maxScrollTop`，并且因为落到了末端又把 `followingEnd` 置回 true —— 视图就弹回底部了。

pi 的 `requestRender()` 是合并的（`if (this.renderRequested) return`），两个扩展的 settle 请求会落到同一帧，所以在 `doRender` 之后读到的 `currentLayout` 已经是收起后的内容，一次就能算对。

### 4. 恢复跟随

`input` 事件里若存在 `pinned` 且 `event.streamingBehavior !== "followUp"`：`sv.scrollToEnd()`、`requestRender()`、清 `pinned`。

### 5. 跨 `/reload` 与不依赖 pi 内部打包细节

- 状态用 `Symbol.for("pi-extension.scroll-to-last-prompt.user-lines")` / `...interactive-mode` 挂在对应 prototype 上，记录原方法与 wrapper，`session_shutdown` 时还原；重复安装时跳过，沿用 `auto-hide-thinking.ts` 的写法（含字段版本号，避免旧对象字段缺失被静默误判）。
- **不 import `@earendil-works/pi-tui` 的任何类、也不 patch 它导出的 prototype**：pi 的 TUI 被内联打包进 `dist/bundle/chunks/*.js`，而扩展 import 解析到的是 `node_modules/@earendil-works/pi-tui` 另一份拷贝，patch 它的 prototype 不会影响运行中的 pi（pi 自己就因此用 `Symbol.for("@earendil-works/pi-tui/layout-node")` 这类全局 symbol 做跨拷贝标识）。
- 挂 `doRender` 钩子时拿的是**运行时** `Object.getPrototypeOf(instance.renderer)`，不依赖那份拷贝，所以跨拷贝有效。因此对 `ScrollView` / `LayoutFrame` / `LayoutBox` 只做鸭子类型（`scrollTo`、`scrollToEnd`、`isFollowingEnd`、`scrollContentLines`、`root`），layout box 遍历自己写 8 行，不调用那份拷贝里的 `getScrollViewBox`。
- `InteractiveMode` 与 `UserMessageComponent` 都从 `@earendil-works/pi-coding-agent` 导出，与运行中的 pi 是同一个模块实例，prototype 包装有效（`auto-hide-thinking.ts` 已验证）。

## 边界与错误处理

- 非 TUI / 非 fullscreen / 拿不到实例 / 拿不到 layout → 空操作，不报错、不打印。
- `Set` 未命中目标行（首次渲染前、会话恢复场景、pi 版本行为变化）→ 空操作。
- 用户手动上翻过 → 不吸附，也不记录 `pinned`，不影响后续自动跟随。
- 落位被 clamp 到内容末端（回复不足一屏）→ 不记录 `pinned`，下一轮继续自动跟随。
- 用户在落位窗口内自己滚走 → 立即停止重试且不记录 `pinned`，之后不会被拽回底部。
- 超过 `PIN_WINDOW_MS` / `PIN_MAX_ATTEMPTS` 仍未稳定 → 记录日志收工；若此时视口还停在目标行，仍按「已吸附」处理，保证下次 input 能恢复跟随。
- 包装的函数抛错时向上抛出交给 pi 原生处理；`doRender` 钩子里的一切异常自己吞掉并写诊断日志（它跑在 pi 的渲染循环里，抛出去会打断渲染）。
- pi 版本缺少 `renderer` / `doRender` / `transcriptScrollView` / `currentLayout` / `scrollContentLines` 任一字段时静默降级为空操作。
- `UserMessageComponent` 未导出或 `render` 不存在时，安装阶段直接放弃并记录一条诊断。

## 验证

离线哈希测试（`/tmp` 下用 jiti 加载扩展，不启动 pi，驱动假 host + 假 layout + **真实 `ScrollView`**，共 44 项断言）：

1. 长回复落位到最后一条用户消息行；只滚一次。
2. **核心回归**：收起前 200 行 / 用户消息在第 150 行，收起后 60 行 / 同一消息在第 20 行 → 必须只按 20 落位，不能先滚 150 再被 clamp。
3. 收起晚一帧（内容在两次尝试之间变）→ 自动按新行号重新落位并稳定在 20。
4. 回复不足一屏 → clamp 到末端、保持跟随、不记 `pinned`。
5. 用户手动上翻过 → 不吸附；落在窗口内自己滚走 → 让位且之后不拽回底部。
6. `alt+enter` 排队 follow-up 不跳；之后正常发送才恢复跟随。
7. `regular` 模式与找不到标记行 → 完全空操作。
8. `/reload` 后不嵌套包装、复用同一份标记、仍能吸附与恢复跟随；`session_shutdown` 后 `render` / `handleEvent` / `doRender` 全部还原。

真机验证（`~/.pi/agent/scroll-to-last-prompt.log`）：

- 每轮应出现 `pin:scroll row=… 共 … 行` 紧跟 `pin:ok`；`pin:clamped` 说明回复不满一屏（正常）；`pin:skip …` 是各条让位规则；`pin:no-match` 才是真失败。
- 下一轮发送消息时应出现 `resume:ok 恢复自动跟随`。

## 不做的事

- 不做 `/命令` 开关或配置项。
- 不做 `regular` 模式下借助终端 scrollback 的降级实现。
- 不改变 `tui.altScreen.previousPrompt`（`ctrl+shift+up`）的内置语义。
