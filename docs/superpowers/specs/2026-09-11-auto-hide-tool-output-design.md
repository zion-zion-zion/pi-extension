# Herdr 下按 Thinking 联动隐藏工具输出设计

## 目标

在 Herdr 的 pi TUI 中，生成期间保留现有的 thinking 与工具输出体验；模型回复完成、thinking 被自动隐藏后，工具输出也完全消失，让用户能快速阅读最终回复。用户需要时按 `Ctrl+T`，同时恢复 thinking 和所有工具块。

## 行为

- 仅在 `HERDR_ENV=1` 且当前运行模式为 `tui` 时生效。
- `agent_start`：目标状态为“过程可见”，即 `hideThinkingBlock=false`，工具块可见；工具块内部原有的“完全折叠 / 预览 / 展开”状态不改变。
- `agent_settled`：目标状态为“过程隐藏”，即 `hideThinkingBlock=true`，所有工具块整体隐藏，包括 Bash 命令、Read/Edit 标题、预览文本及红/绿背景。
- 用户按 `Ctrl+T`：继续使用 pi 原生 thinking 开关，同时同步工具块整体可见性；显示过程时恢复工具块，隐藏过程时隐藏工具块。
- `Ctrl+O` 的原生语义不变：只切换工具块内部的预览/完整输出状态，不改变工具块整体是否显示。
- 现有自动 thinking 翻转的状态提示静音逻辑继续保留；用户手动操作仍显示 pi 原生提示。

## 实现方案

不改变 session 数据结构，也不把工具结果复制进 thinking。扩展通过兼容性 patch 复用 pi 已有组件：

1. 在 `InteractiveMode.prototype.toggleThinkingBlockVisibility` 外包一层，先调用原方法，再读取实例上的 `hideThinkingBlock`。
2. 在 `ToolExecutionComponent.prototype.render` 与 `BashExecutionComponent.prototype.render` 外包一层：当实例的过程可见标志为 false 时返回空数组，否则调用原 render。这样不改工具组件自己的 `expanded` 状态和 `updateDisplay()` 逻辑。
3. 通过 `InteractiveMode.prototype` 的统一状态标志通知工具组件。扩展维护过程可见状态，并在自动 Ctrl+T 注入完成后同步；手动 Ctrl+T 由 prototype wrapper 同步。
4. 使用 `Symbol.for` 保存原始方法，避免 `/reload` 或重复加载造成多层 wrapper。
5. 自动隐藏工具输出不发送 `Ctrl+O`，因此不会破坏用户对每个工具块既有的展开/预览状态。

## 边界与错误处理

- 非 Herdr、非 TUI、没有 pane ID 或 print/RPC 模式不注入按键，也不 patch 工具显示。
- 工具 render 抛错时仍交给 pi 原生实现处理；可见性 wrapper 只决定是否返回空数组。
- 读取 `settings.json` 失败时不猜测状态、不发送翻转键，避免异步落盘期间误翻转。
- 如果自动按键失败，恢复静音计数并停止本次状态请求，不影响 pi 原生功能。
- 工具组件不存在或 pi 版本没有对应 prototype 方法时，扩展应安全空操作。

## 验证

- 用 jiti 加载扩展，确认在 Herdr TUI 环境下只注册一次 hook，重复加载不会嵌套 patch。
- 静态检查确认两个工具组件的原始 `render` 均被包装，隐藏时返回空数组、显示时保留原返回值。
- 在实际 Herdr pane 中验证：生成期间工具表现不变；settled 后工具块完全消失；`Ctrl+T` 后 thinking 与工具块同时恢复；`Ctrl+O` 仍只改变内部展开程度。
- 验证红色/绿色状态背景随工具整体隐藏，恢复后仍按成功/失败状态显示。
