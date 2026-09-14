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

### 3. 吸附

`agent_settled` 时按顺序：

1. `instance.ui.mode !== "fullscreen"` → 返回。
2. `frame = instance.ui.currentLayout`；`sv = frame?.primaryScrollView`；任一缺失 → 返回。
3. `sv.isFollowingEnd !== true` → 返回（方案 A：尊重手动滚动）。
4. 在 `frame.root` 里深度优先找 `box.scrollView === sv` 的 box，取其 `scrollContentLines`；缺失 → 返回。
5. 从 `scrollContentLines` 末行往上扫，找第一个字符串命中 `Set` 的行号 `row`（即最后一条用户消息的首行）；找不到（如首次渲染前、`Set` 为空）→ 返回。
6. `sv.scrollTo(row)`；`instance.ui.requestRender()`。
7. 若 `sv.isFollowingEnd === true`（被 clamp 到底部）则不算吸附，否则记录 `pinned = { sv, tui }`。

读 `frame.scrollContentLines` 而不重新渲染的理由：零额外开销，且行号稳定——`auto-hide-thinking.ts` 在同一轮结束收起工具块时，只会改变这条用户消息**下方**的行，它的绝对行号不受影响。

### 4. 恢复跟随

`input` 事件里若存在 `pinned` 且 `event.streamingBehavior !== "followUp"`：`sv.scrollToEnd()`、`requestRender()`、清 `pinned`。

### 5. 跨 `/reload` 与不依赖 pi 内部打包细节

- 状态用 `Symbol.for("pi-extension.scroll-to-last-prompt.user-lines")` / `...interactive-mode` 挂在对应 prototype 上，记录原方法与 wrapper，`session_shutdown` 时还原；重复安装时跳过，沿用 `auto-hide-thinking.ts` 的写法（含字段版本号，避免旧对象字段缺失被静默误判）。
- **不 import `@earendil-works/pi-tui` 的任何类、也不 patch 它的 prototype**：pi 的 TUI 被内联打包进 `dist/bundle/chunks/*.js`，而扩展 import 解析到的是 `node_modules/@earendil-works/pi-tui` 另一份拷贝，patch 它的 prototype 不会影响运行中的 pi（pi 自己就因此用 `Symbol.for("@earendil-works/pi-tui/layout-node")` 这类全局 symbol 做跨拷贝标识）。
- 因此对 `ScrollView` / `LayoutFrame` / `LayoutBox` 只做鸭子类型（`scrollTo`、`scrollToEnd`、`isFollowingEnd`、`scrollContentLines`、`root`），layout box 遍历自己写 8 行，不调用那份拷贝里的 `getScrollViewBox`。
- `InteractiveMode` 与 `UserMessageComponent` 都从 `@earendil-works/pi-coding-agent` 导出，与运行中的 pi 是同一个模块实例，prototype 包装有效（`auto-hide-thinking.ts` 已验证）。

## 边界与错误处理

- 非 TUI / 非 fullscreen / 拿不到实例 / 拿不到 layout → 空操作，不报错、不打印。
- `Set` 未命中目标行（首轮首次渲染前、会话恢复场景、pi 版本行为变化）→ 空操作。
- 用户手动上翻过 → 不吸附，也不记录 `pinned`，不影响后续自动跟随。
- 滚动目标恰好是内容末端 → 不记录 `pinned`，下一轮继续自动跟随。
- 包装的函数抛错时向上抛出交给 pi 原生处理；扩展自身的吸附逻辑用 try/catch 包住，失败只记录诊断日志（TUI 下不写 stderr）。
- pi 版本缺少 `transcriptScrollView` / `currentLayout` / `scrollContentLines` 任一字段时静默降级为空操作。
- `UserMessageComponent` 未导出或 `render` 不存在时，安装阶段直接放弃并记录一条诊断。

## 验证

- `pi -e ./extensions/scroll-to-last-prompt.ts` 手动验证 6 个场景：
  1. 长回复（超过一屏）结束 → 屏幕第一行是本轮用户消息。
  2. 短回复（不足一屏）结束 → 视图停在底部、仍跟随最新，无异常。
  3. 生成中手动上翻 → 结束时不吸附。
  4. `Esc` 中断 → 按同样规则吸附。
  5. `alt+enter` 排队 follow-up → 不跳走；再正常发送一条消息 → 恢复跟随并跳到底部。
  6. `--tui-mode regular`（或在 `settings.json` 临时改回）→ 完全空操作。
- 静态检查：重复加载 `/reload` 后 wrapper 只存在一层，`session_shutdown` 后 prototype 恢复为原方法。
- 静态检查：连续多轮对话中，每轮吸附的都是**当轮**用户消息，而不是上一轮或助手回复的首行（这依赖 `Set` 命中而非 `133;A` 扫描）。

## 不做的事

- 不做 `/命令` 开关或配置项。
- 不做 `regular` 模式下借助终端 scrollback 的降级实现。
- 不改变 `tui.altScreen.previousPrompt`（`ctrl+shift+up`）的内置语义。
