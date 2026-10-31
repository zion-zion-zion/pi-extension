# Herdr 圆角图形背景独立探针

## 目标

在用户授权下验证 Kitty PNG 图像及负 z 图层能否在本机 Herdr 显示，保持当前 pretty-tui 实现不变。

## 方法

- 在当前 tab 新建无焦点 sibling pane，运行本仓库 scripts/rounded-bubble-probe.py；不启动任何子 Agent。
- Python/Pillow 生成透明圆角 PNG，先发送 Kitty query，再分别显示普通图像与负 z 底图叠加原生文字。
- 从测试 pane 查询字符格像素尺寸，失败时显式标注估算，不误报精确对齐。
- 提供键盘 s（滚动）、r（重画）、q（退出并清理本探针图像），验证真实终端中的滚动和排版。
- 日志和 PNG 写入 .local-tests/rounded-bubble-probe/，不读聊天/密钥，不改用户配置或现有扩展。

## 验证边界

协议回应只说明接受指令；必须由用户观察独立 pane 截图才能判断视觉成功。简单备用屏探针也不能替代 Pi ScrollView 中的全量集成验证。
