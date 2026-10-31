# Pi 对话区左右 15% 留白

## 需求与范围

用户希望整个右侧 Pi 对话区不贴边：按 Pi transcript 区域的宽度，左右各留 15%，中间约 70% 承载用户气泡、助手消息、工具/思考与回复完成分隔线。Herdr 侧边栏不参与计算；输入框、widgets、底部状态栏不改。

## 实现

- 本地 /Users/jiezhou/Desktop/公司其他/pi-pretty-tui 新增 transcript-margins.ts，只对 InteractiveMode.chatContainer 实例包装 render/handleMouse，不全局改所有 Container。
- 将内部宽度传给原渲染，再补等宽左右空白。保留行首 OSC133 语义标记，清除样式后补右侧空白。图片与 rounded-bubbles 的行标记仍保留，最终屏幕绘制自动获得新的横坐标。
- 鼠标事件必须同步减去左边距、使用内部宽度；边距区域不触发内容点击，保留原始 screenX/Y 供捕获坐标计算。
- config 新增 transcriptMarginRatio，默认 0.15，允许 0..0.30；0 关闭。保持至少 60 列内容，窗口不足 60 列时不额外留白。参数由配置设置但外部修改需重启。
- 在 renderSessionEntries、addMessageToChat 和运行时通知入口确保实例已包装；shutdown 按属性描述符恢复，避免重复包装与新旧闭包叠加。

## 验证

对 1..300 列检查边距、内容最小宽度、ANSI/中文/链接/图片行与 OSC133；鼠标坐标映射、边距点击、重复attach与shutdown恢复；真实 ScrollView 中检查圆角图片横向位置、缩放与文本选择。原回归显式 margin=0 保留旧测试基线，新增测试单独覆盖默认15%。完整 npm test 与宿主加载检查。

## 文档与生效

本次更新 LOCAL-CHANGES 与独立的本地完整恢复快照；不覆盖 Notion 中已归档的无边距版本。/restart 换进程清除旧实例方法/渲染补丁后用户确认留白观感。
