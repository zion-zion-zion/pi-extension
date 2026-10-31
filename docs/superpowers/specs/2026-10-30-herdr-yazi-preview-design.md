# Herdr + Yazi 剪贴板预览

## 目标

在 Herdr 里的 Pi 按 Ctrl+Alt+Y，读取 macOS 文本剪贴板中的单个路径，在当前 Pi 右侧创建 Yazi pane 并定位文件或目录；退出 Yazi 后关闭新建 pane。保留 Ctrl+Y 的 Pi 默认行为。

## 方案

Pi 单文件扩展注册快捷键和 `/yazi-preview` 备用命令。只在 macOS、Pi TUI、Herdr pane 内执行；读取剪贴板后先尝试原始路径，再尝试去除常见行号后缀，支持相对当前项目目录、`~`、首尾引号及 Markdown 文件链接。校验存在且是文件或目录，拒绝包含控制字符的路径。无效输入直接通知，不创建 pane。

使用 `herdr pane split --pane <当前 pane> --direction right --cwd <Pi cwd> --env YAZI_PREVIEW_PATH=<绝对路径> --focus` 创建 pane，解析返回的 pane ID；`herdr pane run` 发送固定 shell 命令，通过环境变量传路径，不把剪贴板拼入 shell 代码。新 pane 里 `sh -c` 启动 Yazi，退出后关闭自身；启动命令投递失败时关闭本扩展刚创建的 pane。每次新建 pane，不追踪或复用旧 pane。不能确认启动或快捷键透传时明确报告限制。

## 验证

检查快捷键、分屏接口和扩展加载；测试路径解析与错误处理，实际创建自己的测试 pane 并验证 Yazi 定位和退出清理。Herdr 和 Ghostty 的实际键盘透传需要用户端确认。
