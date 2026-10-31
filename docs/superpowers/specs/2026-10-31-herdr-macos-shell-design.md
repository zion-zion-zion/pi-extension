# herdr macOS 窗口级外壳改造方案

- 日期：2026-10-31
- 状态：设计方案，尚未实现
- 目标平台：macOS + Ghostty + herdr 0.9.0

## 1. 背景与目标

herdr 是 Rust + `ratatui` 的终端界面，最终输出是字符网格，不存在可以直接注入 CSS 的网页 DOM。现有 herdr 配置可以调整颜色、边框、留白和列表间距，但无法稳定实现像素级圆角、阴影、毛玻璃和浮层。

本方案探索一条不修改 herdr 主渲染源码的路线：制作一个独立的 macOS 原生辅助窗口（以下简称 Shell），由 Shell 绘制窗口级视觉效果，并通过 herdr 的只读状态快照逐步适配内部布局。

目标：

1. 不接管 herdr 的 PTY、键盘、鼠标、会话、快捷键和 Agent 生命周期。
2. 为 Ghostty/herdr 增加真实的窗口级圆角、阴影、外边距和柔和边缘效果。
3. 可选地根据 herdr 状态为当前 pane 绘制非侵入式高亮。
4. Ghostty 移动、缩放、切换 Space、失焦和关闭时不产生残留或明显错位。
5. 先做独立原型，再决定是否需要给 herdr 增加最小的布局信息 API。

非目标：

- 不在第一版重绘 herdr 的 Agents 列表、Tab 或终端文字。
- 不用外壳替代 herdr 的交互和布局计算。
- 不追求通过固定坐标完整模拟网页卡片 UI。
- 不在第一版维护 herdr 的完整 fork。

## 2. 总体架构

```text
Ghostty + herdr
  └─ 负责终端、字符绘制、输入、PTY 和会话

Herdr Shell.app
  ├─ 定位 Ghostty 窗口
  ├─ 创建透明、不可激活、鼠标穿透的 NSPanel
  ├─ 同步 Ghostty 的位置、大小、可见性和焦点
  ├─ 绘制圆角、阴影、边缘光晕和外层装饰
  ├─ 调用 `herdr api snapshot` 获取状态
  └─ 可选：把 pane 的终端网格矩形映射为屏幕像素矩形
```

屏幕层级：

```text
macOS 桌面
  └─ Shell overlay（透明装饰层，鼠标穿透）
      └─ Ghostty 窗口
          └─ herdr TUI
              └─ Agent / pane / tab 内容
```

Shell 必须是装饰层，而不是第二个交互客户端。任何点击、拖动、快捷键和文本输入都必须继续进入 Ghostty。

## 3. 技术实现

### 3.1 Ghostty 窗口定位

使用 macOS Accessibility API 获取 Ghostty 的进程和窗口：

- `AXUIElementCreateApplication(pid)`
- `kAXWindowsAttribute`
- `kAXPositionAttribute`
- `kAXSizeAttribute`
- `kAXFocusedAttribute`（如可用）
- `kAXPositionChangedNotification`
- `kAXUIElementDestroyedNotification`

`CGWindowListCopyWindowInfo` 可作为窗口发现或轮询兜底，但不作为唯一同步机制。

首次运行需要用户在“系统设置 → 隐私与安全性 → 辅助功能”授予 Shell 辅助功能权限。Shell 不读取键盘内容，也不注入按键；权限用途仅限于读取和跟随 Ghostty 窗口几何信息。

Ghostty 查找策略：

1. 通过工作进程名称 / bundle identifier 找到 Ghostty 进程。
2. 枚举其可见标准窗口。
3. 选取前台、非最小化、尺寸有效的目标窗口。
4. 监听窗口变化并在失效时重新发现。

### 3.2 Overlay 窗口

第一版使用 AppKit 的无边框非激活面板：

```swift
let panel = NSPanel(
    contentRect: frame,
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.isOpaque = false
panel.backgroundColor = .clear
panel.ignoresMouseEvents = true
```

建议配置：

- `level` 只在 Ghostty 前台时保持在合适层级，避免覆盖其他应用。
- `hasShadow = false`，阴影由自定义 view 绘制，避免系统阴影与圆角错位。
- 不让 panel 成为 key window，不抢键盘焦点。
- Ghostty 失焦、隐藏、最小化或离开当前 Space 时隐藏 overlay。
- Ghostty 关闭时销毁或隐藏 overlay，并停止轮询。

Shell 自定义 `NSView` 使用 Core Graphics / Core Animation 绘制：

- 外部圆角路径。
- 低透明度边缘描边。
- 多层柔和阴影。
- 可选的暖色背景或边缘光晕。
- 焦点态与失焦态的透明度变化。

第一版不要在 Ghostty 内容区域上绘制不透明卡片，以免覆盖文字和光标。

### 3.3 窗口同步

同步来源采用“Accessibility 通知 + 低频轮询兜底”：

- 窗口移动：立即更新。
- 窗口缩放：立即更新。
- 每 200–300ms 检查一次 frame、可见性、进程和焦点，修复通知丢失。
- 使用 `backingScaleFactor` 处理 Retina point/pixel 转换。
- 更新时做小幅去抖，避免 Ghostty resize 期间 overlay 抖动。
- 当 frame 无效或窗口未准备好时隐藏 overlay，而不是绘制到旧位置。

适配窗口边界时要明确外壳的视觉模型：

```text
Ghostty frame
  └─ inset / outset 视觉区域
      ├─ 外部透明留白
      ├─ 圆角轮廓
      └─ 阴影扩散区域
```

如果 Ghostty 自己已经有窗口圆角，Shell 默认只绘制外围阴影和细边缘，避免重复圆角造成黑边。

## 4. herdr 页面适配策略

### 4.1 第一层：整个窗口

第一版完全不依赖 herdr 内部布局，只适配 Ghostty 的总 frame。可以实现：

- 真实窗口级圆角。
- 外围留白。
- 柔和阴影。
- 轻微边缘光晕。
- 前台 / 后台窗口的不同透明度。

这一层对 workspace、tab、pane、sidebar 的变化不敏感，稳定性最高。

### 4.2 第二层：pane 状态与几何

herdr 当前可通过：

```bash
herdr api snapshot
```

获取只读运行状态。快照包含：

- `focused_pane_id`、`focused_tab_id`、`focused_workspace_id`。
- panes 的 `pane_id`、`rect`、workspace、tab、Agent 状态。
- tabs、workspaces 及其 focus 和状态。
- terminal viewport 行数等信息。

当前快照中的 pane `rect` 使用终端字符网格坐标，例如：

```json
{
  "pane_id": "w5:p1A",
  "rect": { "x": 0, "y": 0, "width": 161, "height": 52 },
  "focused": true
}
```

将字符网格转换为屏幕像素：

```text
pixel_x = ghostty_content_x + cell_x * cell_width
pixel_y = ghostty_content_y + cell_y * cell_height
```

其中 `cell_width` / `cell_height` 通过终端内容尺寸与列行数计算，必须考虑窗口 padding、tab bar、sidebar 和 Retina 缩放。

第二版可只为 focused pane 绘制：

- 非遮挡的边缘高亮。
- 在 pane 间隙上的柔和阴影。
- 根据 Agent 状态的极细颜色提示。

如果 pane rect 不能可靠映射，应降级为只画窗口级外壳，不能盖住终端内容。

### 4.3 第三层：Agents 列表

Agents 列表的状态可以从 snapshot 获取，但当前 snapshot 不直接保证返回每一行在屏幕上的矩形。因此外壳不能直接知道每个 Agent 行的精确像素位置。

可行但不完全稳定的推算输入：

- `ui.sidebar.sidebar_width`。
- 终端行列数和 cell 尺寸。
- `[ui.sidebar.agents]` 的 `rows`。
- `row_gap`。
- workspace / Agent 排序。
- 当前侧栏是否折叠、是否进入 mobile 布局。

推算方案只适合实验，不应在第一版用不透明背景覆盖 Agents 文字。窗口缩放、字体修改、侧栏滚动、布局阈值变化和 herdr 升级都可能造成误差。

如果确实需要精确的 Agent 卡片，后续只给 herdr 增加一个只读布局输出，不重写会话逻辑：

```json
{
  "sidebar": { "rect": { "x": 0, "y": 0, "width": 28, "height": 52 } },
  "agent_rows": [
    {
      "id": "w5:p1A",
      "rect": { "x": 1, "y": 18, "width": 26, "height": 2 },
      "status": "working",
      "focused": true
    }
  ]
}
```

这样 herdr 仍然负责布局计算，Shell 只负责绘制。

## 5. 推荐的代码结构

建议新增独立目录，不把 Shell 代码混进现有 TypeScript 扩展：

```text
/Users/jiezhou/Desktop/公司其他/pi-extension/herdr-shell/
├── Package.swift
├── Sources/
│   ├── main.swift
│   ├── GhosttyLocator.swift
│   ├── OverlayPanel.swift
│   ├── WindowTracker.swift
│   ├── HerdrSnapshot.swift
│   ├── GeometryMapper.swift
│   └── ShellRenderer.swift
└── README.md
```

模块职责：

- `GhosttyLocator.swift`：发现 Ghostty PID 和目标窗口。
- `WindowTracker.swift`：Accessibility 通知、轮询、去抖、可见性处理。
- `OverlayPanel.swift`：创建和管理透明 `NSPanel`。
- `HerdrSnapshot.swift`：调用 `herdr api snapshot`，解析 JSON，处理超时和旧数据。
- `GeometryMapper.swift`：终端字符坐标、窗口坐标、屏幕坐标转换。
- `ShellRenderer.swift`：圆角、阴影、边缘、focused pane 装饰。
- `main.swift`：权限检查、生命周期和错误日志。

## 6. 分阶段实施

### Phase 0：可行性验证

只写最小 Swift App：

1. 找到 Ghostty 窗口。
2. 创建鼠标穿透透明面板。
3. 绘制明显但不遮挡内容的彩色轮廓。
4. 移动和缩放 Ghostty，确认轮廓跟随。
5. 点击 Ghostty，确认输入和鼠标没有被 Shell 截获。

验收：连续移动、缩放、切换窗口 10 分钟，无残留面板和输入异常。

### Phase 1：窗口级视觉

加入：

- Kimi 风格暖白 / 暖灰外壳。
- 真实圆角。
- 柔和阴影。
- 焦点 / 失焦透明度。
- Ghostty 关闭和重启后的自动恢复。

验收：仅关闭 Shell 即恢复原始 Ghostty 画面；无配置或 herdr 数据修改。

### Phase 2：pane 适配

加入：

- 定时读取 `herdr api snapshot`。
- 仅处理 focused pane。
- 将 pane rect 映射到屏幕坐标。
- 只画边缘和间隙区域，不覆盖文字。
- snapshot 失败、过期或坐标不可信时自动降级到 Phase 1。

验收：切换 pane、split、tab、workspace、缩放窗口后装饰不明显错位。

### Phase 3：精确布局接口（可选）

只有 Phase 2 证明需要时才做：

1. 给 herdr 增加只读布局快照。
2. 暴露 sidebar rect、Agent row rect、tab rect 和 layout mode。
3. 版本化字段并允许 Shell 忽略未知字段。
4. Shell 仅使用布局数据绘制，不参与 herdr 状态修改。

验收：Agent 行卡片在不同窗口尺寸、列表滚动和移动布局下仍能对齐。

## 7. 风险与降级

### 权限风险

Accessibility 权限缺失时，Shell 必须显示明确提示并退出视觉跟随，不应循环请求或影响 Ghostty。

### 坐标错位

任何来自旧 snapshot、窗口 resize 中间态或分辨率转换的坐标都可能过期。超过阈值时直接隐藏 pane 装饰。

### 层级污染

Shell 不能长期以全局最高层级显示。Ghostty 失焦后隐藏或降级，否则会盖住其他应用。

### 性能

窗口级绘制不应动画。snapshot 轮询建议 2–5Hz，只有状态变化或窗口变化时重绘；避免高频截图或全屏重绘。

### 版本兼容

herdr 0.9.0 的 snapshot 字段和布局实现可能变化。解析器必须容忍缺失字段；Shell 识别不到版本或字段时只保留窗口级外壳。

### 文字和输入安全

Shell 默认鼠标穿透、不注入键盘、不读取终端内容。任何可能覆盖终端字符的绘制都必须关闭或使用低透明度边缘效果。

## 8. 验收标准

- [ ] Shell 能找到当前 Ghostty 窗口并绘制装饰。
- [ ] Ghostty 移动、缩放、切换 Space 后外壳跟随。
- [ ] Shell 不抢焦点、不截获鼠标和键盘。
- [ ] Ghostty 失焦时外壳正确隐藏或降低显示层级。
- [ ] Ghostty 关闭后无残留窗口，重新启动可恢复。
- [ ] herdr 的 PTY、快捷键、会话、Agent 状态和配置不被修改。
- [ ] snapshot 超时或解析失败时不会显示旧的 pane 装饰。
- [ ] pane 装饰无法准确映射时自动降级为窗口级装饰。
- [ ] 未实现 herdr 布局 API 前，不承诺 Agents 行的精确卡片覆盖。

## 9. 最终建议

优先实现 Phase 0 和 Phase 1，不先改 herdr 源码，也不先做完整 Agent 卡片。这样能验证“窗口级外壳”本身是否带来足够的视觉收益，同时把输入、布局和版本兼容风险隔离在独立程序中。

如果窗口级效果满意，再接入 `herdr api snapshot` 做 focused pane 的非侵入式高亮。只有确实需要精确装饰 Agents 行、Tab 或所有 pane，才为 herdr 增加最小的只读布局接口；不建议用固定坐标长期模拟内部布局。
