# Pi Codex 额度状态扩展设计

## 目标

为 Pi 增加全局 `/status` 命令，让使用 `openai-codex` OAuth 登录的用户无需打开网页，即可查看 ChatGPT Codex 的 5 小时额度和周额度。扩展同时在 Pi 底部状态栏常驻显示额度摘要。

成功标准：

- `/status` 主动获取并展示最新的 5 小时和周额度。
- 状态卡默认横向单行展示两个额度窗口，并包含内嵌进度条。
- Pi 启动后以及每次 `openai-codex` 模型请求结束后自动刷新底部摘要。
- 扩展复用 Pi 管理的 OAuth，不自行保存、记录或显示任何凭据。
- 网络或接口暂时失败时保留最后一次成功数据，并明确标记其可能过期。

## 范围

本次实现是一个用户级 Pi 扩展，安装到：

```text
~/.pi/agent/extensions/codex-usage/
```

扩展只读取额度，不购买额度、不兑换重置券、不修改账号设置，也不提供模型调用量统计图。

## 技术依据

OpenAI Codex CLI 通过以下接口读取 ChatGPT Codex 额度：

```http
GET https://chatgpt.com/backend-api/wham/usage
```

请求使用 OAuth bearer token，并携带 JWT 中的 ChatGPT 账号 ID：

```http
Authorization: Bearer <token>
ChatGPT-Account-ID: <account-id>
Accept: application/json
```

Pi 扩展可以通过以下接口获取由 Pi 解析、刷新后的 `openai-codex` OAuth 认证：

```ts
ctx.modelRegistry.getProviderAuth("openai-codex")
```

`/wham/usage` 是 Codex 使用的内部接口，不属于稳定的公开 API。因此响应解析必须封装在独立模块中，并对未知字段保持宽容。

## 架构

扩展采用目录结构：

```text
codex-usage/
├── index.ts       # Pi 生命周期、/status 命令与状态栏集成
├── client.ts      # OAuth 解析与 HTTP 请求
├── parser.ts      # 原始响应到内部快照的转换
├── format.ts      # 状态卡、状态栏和时间格式化
└── *.test.ts      # 单元测试
```

模块职责：

- `index.ts` 只负责编排，不理解接口原始字段。
- `client.ts` 获取 Pi OAuth、提取账号 ID并请求额度接口。
- `parser.ts` 校验最小必要字段，将不稳定的接口结构转换为稳定内部结构。
- `format.ts` 只接收内部结构，生成与终端宽度相适应的显示内容。

## 内部数据模型

```ts
interface UsageSnapshot {
  planType?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  fetchedAt: number;
}

interface UsageWindow {
  usedPercent: number;
  resetAt?: number;
  windowMinutes?: number;
}
```

解析规则：

- 在 `primary_window`、`secondary_window` 及未来可能新增的窗口中，根据窗口时长识别额度类型，不依赖字段顺序。
- 约 300 分钟的窗口识别为 5 小时额度。
- 约 10080 分钟的窗口识别为周额度。
- 若接口只返回标准 primary/secondary 窗口但缺少时长，可将 primary 作为 5 小时、secondary 作为周额度兼容处理。
- `remainingPercent = clamp(100 - usedPercent, 0, 100)`。
- 数值缺失或无效时不推测，用“不可用”代替。
- 未识别字段忽略，避免接口增加字段导致整个解析失败。

## 认证与安全

1. 调用 `ctx.modelRegistry.getProviderAuth("openai-codex")`，由 Pi 负责 OAuth 刷新。
2. 从内存中的 bearer token 解码 JWT payload，仅提取：

   ```text
   https://api.openai.com/auth.chatgpt_account_id
   ```

3. 发起 HTTPS 请求，请求超时为 10 秒。
4. token、完整 JWT、账号 ID、请求头和原始响应均不写入日志、会话或缓存文件。
5. 用户可见错误只包含错误类别和恢复建议，不包含服务端原始敏感内容。
6. 缓存仅存在扩展进程内，Pi 退出后自动消失。

当前模型不是 `openai-codex` 时，`/status` 仍可查询已经登录的 `openai-codex` 账号。只有自动的请求后刷新受当前请求 provider 限制。

## 刷新机制

扩展维护：

```ts
let latestSnapshot: UsageSnapshot | undefined;
let refreshInFlight: Promise<UsageSnapshot> | undefined;
```

刷新触发点：

- `session_start`：后台刷新，不阻塞 Pi 启动。
- `turn_end`：当该轮 assistant 响应的 provider 为 `openai-codex` 时后台刷新。
- `/status`：主动刷新，完成后显示状态卡。

并发规则：

- 同一时刻只允许一个额度请求。
- 后续触发复用 `refreshInFlight`。
- 请求成功后原子替换 `latestSnapshot` 并刷新底部状态。
- 请求失败不覆盖最后一次成功快照。
- 自动刷新失败不弹出干扰通知，仅在状态栏标记陈旧状态。
- `/status` 失败时给出明确错误；若存在旧快照，同时展示旧快照和实际更新时间。

## 展示设计

### `/status` 状态卡

默认在一行横向展示：

```text
Codex · Pro   5h ███████░░░ 68% · 2h14m   │   Week ████░░░░░░ 39% · 3d8h   · now
```

显示规则：

- 进度条表示剩余额度，而不是已用额度。
- 宽屏默认每个进度条 10 格。
- 百分比表示剩余百分比。
- 额度窗口后的时间表示距离重置还剩多久。
- 状态卡通过 `pi.appendEntry()` 写入 TUI-only 自定义条目，不发送给模型，不占用模型上下文。
- 终端宽度不足时，先将进度条缩短到 5 格：

  ```text
  Codex  5h ███░░ 68%  │  Week ██░░░ 39%
  ```

- 仍不足时按额度区块折为最多两行，而不是让每个字段单独占一行。
- 极窄终端可移除进度条，只保留 `5h:68%` 与 `Week:39%`。
- 数据陈旧时末尾显示警告符号和实际更新时间。

### 底部状态栏

成功状态：

```text
Codex 5h:68% Week:39%
```

旧缓存状态：

```text
Codex 5h:68% Week:39% ⚠
```

无数据状态：

```text
Codex usage unavailable
```

状态栏不包含进度条和重置倒计时，避免持续占用过多宽度。

## `/status` 命令行为

`/status` 是扩展注册的命令，执行时不触发模型调用：

1. 在底部状态区域临时显示 `Refreshing Codex usage…`，不打开阻塞式对话框。
2. 请求最新额度。
3. 成功时追加紧凑状态卡，并恢复正常额度摘要。
4. 失败且有缓存时追加带陈旧标记的状态卡，并显示简短警告。
5. 失败且无缓存时显示错误和恢复建议。

可能的恢复建议：

- 未登录：运行 `/login openai-codex`。
- OAuth 无效或刷新失败：运行 `/logout openai-codex` 后重新登录。
- 网络超时：检查网络后重试 `/status`。
- 响应格式不兼容：升级扩展或 Pi。

## 错误处理

错误划分为稳定的内部类别：

- `not_authenticated`
- `invalid_token`
- `request_timeout`
- `unauthorized`
- `http_error`
- `invalid_response`

HTTP 401/403 不回显响应正文。其他 HTTP 错误也只报告状态码。JSON 解析错误不附带原始响应。

接口中某一个窗口缺失时，仍展示另一个有效窗口；只有两个目标窗口都无法识别时才判定为无可用额度数据。

## 测试

单元测试覆盖：

- 从有效 JWT 提取 ChatGPT 账号 ID。
- JWT 缺段、非法 base64、非法 JSON 和 claim 缺失。
- 从标准 primary/secondary 响应解析 5 小时和周额度。
- 根据窗口时长识别乱序窗口。
- 接口缺失字段、增加未知字段和只返回一个窗口。
- 百分比小于 0 或大于 100 时的边界处理。
- 重置时间的小时、天和已到期格式。
- 10 格、5 格及极窄终端布局。
- 401、403、500、超时和非法 JSON。
- 网络失败时保留旧缓存并标记陈旧。
- 多个同时刷新触发只执行一次 HTTP 请求。
- 用户错误与日志不包含 token、JWT 或账号 ID。

手工验证：

1. 在 Pi 中运行 `/login openai-codex`。
2. `/reload` 后确认启动不被额度请求阻塞。
3. 执行 `/status`，与 ChatGPT Codex usage 页面显示对照。
4. 发起一次 `openai-codex` 模型请求，确认请求结束后底部摘要更新。
5. 切换到其他 provider，确认 `/status` 仍可查询，但其他 provider 请求不会触发自动刷新。
6. 断网后运行 `/status`，确认旧数据保留且没有泄露凭据。
7. 调整终端宽度，确认状态卡优先保持单行，最多折成两行。

## 非目标

- 不替换 Pi 默认 footer。
- 不读取 Codex CLI 自己的认证文件。
- 不启动 Codex app-server 子进程。
- 不使用定时器持续轮询。
- 不把额度数据发送给模型。
- 不承诺内部接口永远兼容；解析失败必须显式暴露，而不是显示错误额度。
