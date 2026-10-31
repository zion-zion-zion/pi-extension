# 输入框与消息区使用相同的左右边距

## 需求

用户已确认消息区 12% 留白合适，但输入框仍全宽，显得割裂。输入区域也使用左右各 12% 的边距，与消息区外缘对齐；沿用 transcriptMarginRatio 这一单一配置，不新加第二个独立比例。

## 方案

复用已有 createTranscriptMargins 管理器，不改 Pi 安装代码，也不再写一套编辑器布局。在 InteractiveMode 的历史重建、实时消息及活动通知入口，除 chatContainer 外，同时 attach(editorContainer)。该容器原生持有 CustomEditor，临时替换为选择/输入组件时也保持一致的输入区域边界。

内部 render 收到缩小后的 contentWidth，原生 CustomEditor 和已有圆角框补丁继续处理换行、补全、光标和内侧边框；最外层只补左右空格，保留原生 CURSOR_MARKER，因此硬件光标与 IME 定位跟随偏移。鼠标事件由同一包装转换为内部坐标，拒绝边距点击；focus 对象仍是原生编辑器，不额外包 Focusable 或截取键盘输入。

页脚、上下 widgets 与独立 overlay 不改。边距与消息区使用同样的整数列取整和至少 60 列内容规则，窄窗口共同收缩；配置为 0 时两者都回到全宽。shutdown 恢复两个容器的方法，重复接入不叠加。

## 验证

在边距专项测试中，通过真实 InteractiveMode 接入 editorContainer，使用真实 CustomEditor 验证 120/200 列边界、中文和长输入换行、原生光标标记偏移、鼠标点击插入位置、边距点击不移动光标、补全列表与替换组件边界、窄窗口及 shutdown 恢复。运行完整 npm test 与开发机软链检查。更新本地说明与 Notion，最后用户 /restart 清理旧实例闭包后视觉确认。
