# Herdr Shell

macOS 原生窗口级外壳原型，为 Ghostty 中运行的 herdr 绘制独立的圆角、阴影和边缘轮廓。

当前实现是 Phase 0 原型：

- 通过 Accessibility API 查找 Ghostty 窗口。
- 使用透明、非激活、鼠标穿透的 `NSPanel`。
- 跟随 Ghostty 移动和缩放。
- Ghostty 失焦、隐藏、最小化或关闭时隐藏外壳。
- 不读取终端内容，不注入键盘，不连接 herdr API，不修改 herdr。

## 构建

```bash
cd /Users/jiezhou/Desktop/公司其他/pi-extension/herdr-shell
swift build -c debug
swift build -c release
```

## 运行

首次运行前，在 macOS 中授予终端或构建出来的程序辅助功能权限：

```text
系统设置 → 隐私与安全性 → 辅助功能
```

然后执行：

```bash
.build/debug/herdr-shell
```

退出：在运行该命令的终端按 `Ctrl+C`。

程序需要辅助功能权限的原因是读取 Ghostty 窗口的位置和尺寸；overlay 设置为 `ignoresMouseEvents = true`，不会抢鼠标和键盘输入。

## 当前视觉效果

当前版本故意使用明显但克制的白色轮廓和阴影，用来验证窗口跟随是否正确。它还不是最终的 Kimi 风格视觉层。

Phase 0 验证通过后，再加入暖白背景、柔和阴影、focused pane 适配和 `herdr api snapshot`。

## 诊断

程序运行时会把状态写入：

```text
/tmp/herdr-shell.log
```

如果看不到效果，先确认旧进程已经退出：回到运行它的 pane 按 `Ctrl+C`，再重新构建并启动：

```bash
cd /Users/jiezhou/Desktop/公司其他/pi-extension/herdr-shell
swift build -c debug
.build/debug/herdr-shell
```

日志中应能看到类似：

```text
accessibilityTrusted=true
tracking Ghostty frame=...
```

找不到 Ghostty、没有辅助功能权限、窗口不可见或 frame 无效时，程序会隐藏 overlay 并继续等待，不会影响 Ghostty 或 herdr。
