# Footer 与消息、输入区统一对齐

用户指出 footer 仍全宽。沿用 transcriptMarginRatio=0.12 和现有 createTranscriptMargins 管理器，在历史重建、实时消息、活动通知三个入口同步 attach(footerContainer)。不改 footer 自身内容或自定义 footer 工厂；它们收到收窄后的宽度，由原生机制换行/截断。鼠标坐标转换、窄窗至少 60 列内容、配置 0 关闭及 shutdown 恢复均复用现有实现。用户随后补充 Todos 挂件也应对齐。因此统一收窄 pendingMessagesContainer、statusContainer、widgetContainerAbove、widgetContainerBelow，加上已有 chatContainer、editorContainer、footerContainer，七个并列区域共享同一比例；独立 overlay 与启动头部不改。集中 attachLayoutMargins(mode) 遍历这些容器，避免三个入口各自漏项。

验证：在真实 createChatViewport 测试中接入 footerContainer，确认 120 列左右各 14 列、200 列左右各 24 列，footer 收到正确的内部宽度，退出后恢复；执行完整 npm test 与软链检查。同步本地说明和 Notion 当前范围，用户 /restart 后确认。
