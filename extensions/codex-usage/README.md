# Codex Usage

Pi 扩展：查看 ChatGPT Codex 的 5 小时额度和周额度。

## 功能

- `/status` 主动刷新并展示紧凑状态卡
- 底部状态栏常驻额度摘要
- 启动后以及 `openai-codex` 请求结束后自动后台刷新
- 复用 Pi 管理的 `openai-codex` OAuth，不保存任何凭据

## 安装

将本目录放到：

```text
~/.pi/agent/extensions/codex-usage/
```

然后在 Pi 中执行 `/reload`。

## 使用

1. `/login openai-codex`
2. `/status`

当前模型不是 `openai-codex` 时，`/status` 仍可查询已登录账号。只有请求结束后的自动刷新会限制在 `openai-codex`。
