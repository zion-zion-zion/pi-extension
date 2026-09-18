# test-astra 设计

日期：2026-09-18
状态：已实现（extensions/test-astra.ts）

## 目标

在 pi 里输入 `/test-astra`，自动以「用户消息」的身份发送一句固定的话：

> without websearching, what's the newest version of google gemini model?

并像手打这句话一样触发一轮回复。用途：测试 / 对比各模型不联网时的知识截止表现。

## 方案

一个单文件扩展（无 UI、无状态），复用 pi 的两个扩展 API：

- `pi.registerCommand("test-astra", ...)` 注册斜杠命令；
- `pi.sendUserMessage(MESSAGE)` 发送用户消息 —— 与 `pi.sendMessage()`（发自定义消息）不同，
  `sendUserMessage` 发的是真正的用户消息，出现在 transcript 里、必然触发一轮 turn。

## 忙碌时的行为

`sendUserMessage` 在 agent 正在流式输出时若不带 `deliverAs` 会抛错。两种选择：

- 直接拒绝并提示（examples/send-user-message.ts 里 `/ask` 的做法）；
- 排队为 `deliverAs: "followUp"`，本轮结束后自动送达。

本扩展选 followUp：命令的语义就是「把这句话发出去」，排队比让用户再敲一次更符合预期，
并用 `ctx.ui.notify` 说明已排队。空闲时直接发送。

## 安装

- `scripts/link.mjs` 的 `ITEMS` 增加一行 → `node scripts/link.mjs --fix` 建
  `~/.pi/agent/extensions/test-astra.ts` 软链（清单是唯一权威来源）。
- 包发布无需改 `package.json`：`pi.extensions` 与 `files` 里的 `extensions/*.ts` 通配已覆盖。
- 改完在 pi 里 `/reload`（或 `/reload-all`）即可发现新扩展；`/reload` 会重新发现资源
  （resources_discover），新增文件不要求换进程。

## 明确不做

- 不接受参数改写消息内容（就是一句固定话，测试用途）。
- 不做任何 UI 组件、状态条。
