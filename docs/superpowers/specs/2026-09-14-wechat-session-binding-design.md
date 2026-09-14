# 微信桥接的会话锚定设计（Herdr workspace 绑定）

## 目标

把微信桥接**锚定在一个专属的 Herdr workspace** 里，让它：

1. **零污染**：微信的对话永远只落在锚点 workspace 的会话文件里，物理上不可能写进任何 TUI 项目会话
2. **锚点跟随会话切换**：在锚点 pane 里 `/new`、`/resume`、`/fork` 之后，桥接和锁自动跟着走，不需要重新 `/wechat start`
3. **微信侧可管理会话**：`/new <名字>`、`/resume`（列出会话）、`/use <序号>`（切换），全部由扩展解析，不经过模型
4. **锁的持有者恒为锚点**：配合 0.3.2 的原子锁 + 心跳，"重复轮询"和"消息落到别的会话"这两类故障在本设计下都不再成立

动机：现在 `autoStart` 是全局配置，重启后**谁先抢到锁微信就跟谁**。实测发生过 8 个 pane 同时重载时有 3～6 个都认为自己拿到了锁，也发生过桥接落到别的项目会话里、把那次对话的上下文冲掉（更严重的是会触发 billion-context 的**有损压缩**，等于永久改写那个会话的历史）。

## 范围

**做：**

- 锚点判定（"我这个 pi 会话是不是锚点"），autostart 只在锚点是真时才抢锁
- 冷启动恢复：锚点 workspace 里没有活着的 pi pane 时，用 `pi -c` 拉起"上次用的那个会话"
- 微信远程命令：`/new <名字>`、`/resume`、`/use <序号|名字>`，`/status` 增加当前会话信息
- 锚点 pane 内的扩展命令：`/wechat new`、`/wechat use`、`/wechat anchor`（拥有命令 ctx，是唯一能真正切会话的入口）
- 通过 `herdr pane run` 把上述扩展命令注入锚点 pane
- 判定结果的可见性：`/wechat status`、`/wechat anchor`

**不做：**

- **不做跨项目**（选项 2）。微信只在一个专属 cwd 的会话命名空间里活动
- **不做非 Herdr 降级**。`HERDR_ENV !== "1"` 时本机制整体不生效（不抢锁、不注入），行为等同于"没这个功能"
- 不做微信侧的交互式选择器（用序号/名字，避免往 pane 里发方向键）
- 不做"一个 workspace 多个锚点 pane"
- 不做自动创建 Herdr workspace（用户手工建一个 label 为 `wechat` 的 workspace 即可；`/wechat anchor up` 列为未决）

## 使用前提

锚点 workspace 的 cwd 必须是一个**专用目录**（建议新建 `~/wechat-space`）。它同时决定两件事：

1. 微信的会话命名空间（`~/.pi/agent/sessions/--<cwd 编码>--/`，见技术依据 D）
2. Agent 的默认工作目录（工具的相对路径都从这里算）

用 `~` 也能跑，但微信的会话会和家目录下其他 pi 会话混在同一个命名空间里，"微信空间"这个概念就不成立了。扩展本身不关心用哪个目录，只按 workspace 里 pane 的 `cwd` 去算会话目录。

## 技术依据

全部结论来自本机实测输出与 pi / herdr 源码，行号为当前安装版本。

**A. Herdr 提供"活指针"：哪个 pane 正在跑哪个 pi 会话**

`herdr pane list` 的每个 pane 含 `pane_id` / `workspace_id` / `cwd` / `agent` / `agent_status` / **`agent_session.value`**。实测：

```
w5:p7  working  /Users/jiezhou/Desktop/公司其他/pi-extension
       agent_session = .../2026-09-14T03-55-18-714Z_01a09e0e-....jsonl   ← 与本会话的 PI_SESSION_FILE 一致
```

`herdr workspace list` 返回 `workspace_id` / `label` / `pane_count`，实测本机 3 个 workspace（`~` / `investment` / `pi-extension`）。

**B. `herdr pane run` = 把文字和回车一次发进 pane**

官方语义（`herdr --skill`）：*"`pane run` atomically sends command text and Enter."* reload-all 已在用同一模式：

```ts
// /Users/jiezhou/Desktop/公司其他/pi-extension/extensions/reload-all/index.ts:301
await execHerdr(pi, ["pane", "run", pane.paneId, "/reload"]);
```

环境判定沿用 `extensions/auto-hide-thinking.ts`：`process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID`。

**C. `-c` 的语义 = "mtime 最新的会话文件"，且只在进程启动时算一次**

`dist/core/session-manager.js:403-417`（`findMostRecentSession`）扫描 `~/.pi/agent/sessions/<cwd编码>/*.jsonl`，**按 mtime 降序取第一个**；`1240-1247`（`continueRecent`）用它。没有"当前会话指针"文件。

推论：`/new` 之后新文件 mtime 最新 → `-c` 指向新会话；但**它只在启动时求值**，所以它只适合做"冷启动默认值"，不能当运行时指针。运行时指针用 A 的 `agent_session`。

**D. 会话目录编码**

`dist/core/session-manager.js:242-247`：`--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`，例：`/Users/jiezhou/wechat-space` → `~/.pi/agent/sessions/--Users-jiezhou-wechat-space--/`。

**E. 会话名字存在会话文件里，可读可写**

- 名字是文件内的 `session_info` 条目（`dist/core/session-manager.js:465`：`if (entry.type === "session_info") name = entry.name`）
- 写名字的 API：`SessionManager.appendSessionInfo(name: string)`（`dist/core/session-manager.d.ts:228`），可在 `newSession({ setup })` 里调用
- 另见 `ExtensionAPI.setSessionName(name)`（`types.d.ts:987`）

**F. 只有命令 ctx 能创建/切换会话**

- `pi.registerCommand(name, { handler: (args, ctx: ExtensionCommandContext) => ... })`（`types.d.ts:896`）
- `newSession` / `switchSession` / `fork` 只在 `ExtensionCommandContext` 上（`types.d.ts:254-293`）
- 事件处理器拿到的是 `ExtensionContext`（`types.d.ts:209`），**没有**这些方法

**G. `pi.sendUserMessage("/new")` 不能当命令用**

`dist/core/agent-session.js:1185`：`sendUserMessage` 以 `expandPromptTemplates: options?.expandPromptTemplates ?? false` 调用 `prompt()`；而 `prompt()` 只在 `expandPromptTemplates` 为真时尝试执行**扩展注册的命令**（`agent-session.js:833`），内置 `/new` 不在这条路径上 → 会被当成普通文本发给模型。

**H. pi 内置 `/resume` 不接受参数**

`dist/modes/interactive/interactive-mode.js:2491`：`if (text === "/resume")` 严格等值，只弹交互式选择器。因此微信侧切换会话**必须自己注册带参数的命令**。

**I. 锁（已在 0.3.2 修好，本设计沿用）**

`O_EXCL` 原子创建 + `.steal` 互斥区内确认后删除陈旧锁 + 8 秒心跳（心跳时校验所有权，失锁即停轮询）。本设计只在"是否允许抢锁"上增加一道锚点闸门，不改变锁本身。

## 架构

四个单元，各自可单测：

| 单元 | 职责 | 依赖 |
|---|---|---|
| `src/anchor.ts` | 纯逻辑 + herdr 调用：解析锚点状态、列会话、解析序号/名字 | `pi.exec("herdr", ...)`、会话目录 |
| `src/index.ts`（桥接生命周期） | session_start 时按锚点判定决定是否抢锁；锚点信息进状态栏 | `anchor.ts`、`auth.ts` 锁 |
| `src/remote-commands.ts`（微信侧） | 解析 `/new` `/resume` `/use`，注入锚点命令 | `anchor.ts` |
| `src/commands.ts`（TUI 侧） | 新增 `/wechat new` `/wechat use` `/wechat anchor`，这些 handler 拥有命令 ctx | `currentCtx = ExtensionCommandContext` |

数据流：

```
微信消息 ──► 轮询进程（= 锚点 pane 的 pi 进程）
              │  /new 修bug
              ▼
        remote-commands.ts ──► herdr pane run <anchorPane> "/wechat new 修bug"
              │                                    │
              │（先回执）                          ▼
              │                       锚点 pane 的 pi 执行扩展命令 handler
              │                                    │（拥有 ExtensionCommandContext）
              └────────── 锁交接 ◄──────────────────┘
                    旧实例 shutdown：停轮询 + 释放锁
                    新实例 session_start：判定锚点 → 抢锁 → 开始轮询
```

## 锚点判定规则

`resolveAnchor()` 返回 `{ isAnchor, reason, workspace, pane, selfSessionFile }`。判定顺序：

1. `HERDR_ENV !== "1"` 或没有 `HERDR_PANE_ID` → `reason: "not-herdr"`，`isAnchor = false`（本机制整体失效）
2. `herdr workspace list` 中找 `label` 等于配置项 `anchorWorkspaceLabel`（默认 `wechat`；`trim` + 忽略大小写）
   - 找不到 → `reason: "no-workspace"`，`isAnchor = false`
3. `herdr pane list` 过滤出 `workspace_id == ws && agent == "pi"`
   - 0 个 → `reason: "no-pane"`（需要冷启动，见下节）
   - ≥1 个 → 取 `agent_session.value` 对应文件 **mtime 最新**的那个作为锚点 pane；其余记为 stale 并在 `/wechat anchor` 里列出
4. 比对：`pane.agent_session.value === 我的会话文件`？
   - 相等 → `isAnchor = true`
   - `agent_session` 为空/无法解析 → **兜底判据**：我的会话文件是否是该 pane `cwd` 下 mtime 最新的 `.jsonl`？是 → `true`
   - 不相等 → `false`

"我的会话文件"取 `ctx.sessionManager.getSessionFile()`，兜底 `process.env.PI_SESSION_FILE`。

**兜底判据为什么必须有**：`/new` 之后本进程立即进入新会话，而 Herdr 侧的 `agent_session` 需要 pi 的集成上报一次（A 的 `source: "herdr:pi"`）。若这个上报有延迟，严格比对会让**刚新建的会话拒绝抢锁 → 微信直接断线**。新增的会话文件必然是该目录 mtime 最新，因此兜底判据能覆盖这个窗口。

## 冷启动与恢复

- **锚点 workspace 存在、且有活着的 pi pane** → 正常路径：那个 pane 的会话启动时自认锚点、抢锁
- **锚点 workspace 存在、但没有 pi pane** → 需要在那个 workspace 里拉起一个 pi。最省事的方式（也是本设计的前提）是**用户自己**在那个 workspace 里开一个 pane 跑 `pi -c`：
  - `-c` 按 C（mtime 最新）恢复"上次用的那个会话"，语义正好是"接着上次聊"
  - 本设计**不自动**创建 workspace / pane（`/wechat anchor up` 列为未决）
- **锚点 workspace 不存在** → `reason: "no-workspace"`，autostart 静默跳过；`/wechat status` 明确显示"锚点 workspace 未找到（label=wechat）"，`/wechat start` 给出同样的提示

## 命令行为

### 微信远程命令（`src/remote-commands.ts`）

| 命令 | 行为 |
|---|---|
| `/new <名字>` | 校验空闲 → 回执"正在新建会话 名字…" → 注入 `/wechat new 名字` |
| `/new` | 同上传入自动名字：`微信 MM-DD HH:mm` |
| `/resume` | 扫锚点 cwd 的会话目录，回列表（见下） |
| `/use <序号\|名字>` | 解析成会话（本地解析，不交给模型）→ **注入时传会话 ID 前缀**（如 `/wechat use a1b2c3d4`），不传序号：序号只在微信侧用于展示和输入，避免"列完到切换之间新增活动把顺序打乱"导致切错会话 |
| `/status` | 增加一行：`会话: 修bug (a1b2c3d4 · 12 条 · 2 分钟前)` |

列表格式（不经过模型，直接回文本）：

```
📋 微信会话（当前: 修bug）
1. 修bug          2 分钟前 · 12 条
2. 论文答辩        昨天 18:20 · 48 条
3. (未命名)        09-12 · 3 条
──────────
共 3 个 · 发 /use 2 切换 · /new <名字> 新建
```

- 最多列 10 条，超出显示 `…还有 N 个`
- 会话名重复时 `new` 自动加后缀（`修bug-2`）

### 锚点 pane 内的扩展命令（`src/commands.ts`）

这三个才是真正干活的地方（拥有命令 ctx）：

| 命令 | 行为 |
|---|---|
| `/wechat new [名字]` | `ctx.newSession({ setup: async (sm) => { sm.appendSessionInfo(name) } })`；无名字则用时间戳名字 |
| `/wechat use <序号\|名字\|ID前缀>` | 解析成路径 → `ctx.switchSession(path)`；只接受**锚点 cwd 下**的会话文件；已经是当前会话则提示 no-op |
| `/wechat anchor` | 打印判定全过程：workspace、pane、agent_session、我的会话文件、用的是严格判据还是兜底判据 |

`/wechat start` 在非锚点会话里执行时**拒绝**，提示："微信桥接只能跑在锚点会话（workspace=wechat, pane=w5:p9）。" 若要强行在当前会话跑，必须显式加 `--anywhere`，并且提示这会让微信污染当前会话、失去隔离保证。

### 非锚点会话的 autostart

静默跳过（只写 debug log），**不 notify**：本机常态 5～11 个 pane，每个都弹提示是噪音。想看原因就去 `/wechat status` / `/wechat anchor`。

## 关键时序（`/new` 的会话交接）

1. 微信 `/new 修bug` 到达轮询进程（它必然就是锚点进程）
2. 校验：`isAnchor`（不是 → 回"桥接不在锚点会话"）；`agentIdle`（不是 → 回"正在忙，稍后再试"）
3. **先回执**："正在新建会话 修bug…" —— 必须在注入之前，因为第 6 步会销毁本实例的 client
4. `herdr pane run <anchorPane> "/wechat new 修bug"`（超时 2s，失败 → 回错误给微信）
5. 锚点 pane 的 pi 把这一行当用户输入 → 扩展命令 handler（`commands.ts`）
6. handler 调 `ctx.newSession(...)`：
   - 旧实例 `session_shutdown` → `stopBridge({ releaseLock: true })` → 停心跳、abort 长轮询、释放锁、`disposeClient()`
   - 新实例 `session_start` → `resolveAnchor()`（走兜底判据）→ 抢锁 → 开始轮询
   - 文档明确：handler 在旧 call frame 里继续执行，之后不能再依赖旧实例状态（`docs/extensions.md:1265-1269`）
7. （可选，P1）新实例抢锁成功后，若配置里有 `pendingWechatNotice`，把它发给微信，例如"✅ 已新建会话：修bug"，然后清掉该字段

第 6 步期间微信侧的写入是"断线状态"，但腾讯侧有游标排队（pi 的 `cursor.json` + `seen-ids.json` 双保险），**不会丢消息也不会重复处理**；重连后接着收。

## 配置

沿用 `~/.pi/agent/wechat-assistant/config.json`（`BridgeConfig`，`src/auth.ts`）：

```json
{
  "autoStart": true,
  "anchorWorkspaceLabel": "wechat",
  "pendingWechatNotice": null
}
```

- `anchorWorkspaceLabel`：锚点 workspace 的 label，默认 `wechat`；**设为空字符串 = 关闭本机制**（回到今天的全局 `autoStart` 行为）
- 另加 `/wechat config anchor <label>` 便于修改
- `pendingWechatNotice` 内部用，不出现在用户文档里

## 错误处理

| 情况 | 行为 |
|---|---|
| herdr 命令超时/非 0 退出 | 视为"判定失败"，**不抢锁**（fail-safe：宁可不接微信，也不污染会话）；`/wechat anchor` 显示原始 stderr |
| `herdr pane list` JSON 解析失败 | 同上 |
| 锚点 pane 有未提交草稿 | 复用 reload-all 的 `detect.ts` 判定；拒绝注入并回微信"锚点窗口有草稿，请先处理" |
| 注入时锚点不是 idle | 拒绝并回微信"锚点正在忙，稍后再试"（延伸：这是命令处理器自己的状态，可直接读） |
| `/use` 序号越界 / 名字不匹配 | 回当前列表 + 错误说明 |
| `/use` 目标会话已被删除 | 回"该会话文件已不存在"，刷新列表 |
| `/use` 目标不在锚点 cwd 下 | 拒绝（与「不做跨项目」一致），回"只能切到微信空间内的会话" |
| `newSession` 被取消（其他扩展 cancel） | 回"新建被取消" |

## 测试

**单元测试**（`node --experimental-strip-types --test`，沿用 `extensions/codex-usage/` 的基建；herdr 调用注入成纯函数入参）

1. `resolveAnchor` 输入矩阵：非 Herdr / 找不到 workspace / 0 pane / 1 pane 严格命中 / 1 pane 指针为空走兜底命中 / 指针指向别的会话且我不是最新 → 非锚点 / 多 pane 取 mtime 最新
2. 会话目录编码（D）
3. 会话列表解析：fixture jsonl（含 `session_info`、未命名、超大文件）→ 名字/时间/条数正确
4. `/use` 参数解析：序号、精确名字、唯一前缀、歧义、越界
5. 自动名字生成与重名加后缀

**手工测试**（必须真跑）

1. 在 label 为 `wechat` 的 workspace 里起 `pi` → 自动成为锚点、抢到锁、开始轮询
2. 在别的 workspace 起 `pi` → 静默跳过，不抢锁（`/wechat status` 显示"非锚点"）
3. 微信 `/new 测试A` → 锚点 pane 换到新会话、名字为 `测试A`、桥接继续工作；微信侧收到回执
4. 微信 `/resume` → 列表与会话目录实际内容一致
5. 微信 `/use 2` → 切回旧会话，问一个只有旧会话知道的事 → 答对（验证上下文真的回来了）
6. `/reload-all` → 锚点仍是锚点、其他 pane 不抢锁（`lsof` 只应有一条到 `ilinkai.weixin.qq.com` 的连接）
7. 锚点 pane 里放一个草稿 → 微信 `/new` → 拒绝且草稿完整保留
8. 关掉锚点 pane → 微信无响应；`/wechat status` 能说明原因（`no-pane`）

## 非目标

- **跨项目会话**（在微信里 `/use` 到 `pi-extension` 项目里的某个会话）。pi 的会话与 cwd 绑定，跨项目要连 cwd 一起处理，复杂度上一个台阶，留作后续增量
- **非 Herdr 降级**。脱离 Herdr 时本机制不生效，行为与今天一致（仍受全局 `autoStart` 影响，但不会自动跑进锚点逻辑）
- **自动创建 workspace / pane**。用户手工建一个 `wechat` workspace 并跑 `pi -c` 即可
- **微信侧方向键驱动 `/resume` 选择器**。用序号，避免往 pane 发方向键这种脆操作
- **多锚点 / 多微信用户分会话**。当前只有一个绑定用户、一个锚点

## 风险与未决

1. **Herdr `agent_session` 的上报延迟**。最坏情况：`/new` 刚建的新会话在严格判据下被判定"非锚点"→ 微信断线。已用 mtime 兜底判据覆盖；实现阶段的第一件事就是在 w5:p7 上实测一次 `/new` 后 Herdr 指针的刷新时延
2. **注入与用户手速竞争**。检测到注入之间用户若恰好开始打字，可能碰撞。窗口毫秒级，沿用 reload-all 的结论：接受
3. **一个 workspace 多个 pi pane**。本设计取"mtime 最新"，语义模糊（"谁最新谁是锚点"）。若实测发现混乱，改为"拒绝多 pane + 要求用户关掉多余的"
4. **`/new` 期间微信短暂无桥接**。锁释放→重新抢、长轮询重连，预计 1～3 秒；期间消息在腾讯侧排队，不丢
5. **会话数量增长带来的列表成本**。列表要遍历会话文件扫 `session_info`；实现时只对包含 `"session_info"` 字样的行做 JSON 解析，并限制只列 10 条。会话数真的很大时再考虑缓存
6. **会话数量增长带来的列表成本**。列表要遍历会话文件扫 `session_info`；实现时只对包含 `"session_info"` 字样的行做 JSON 解析，并限制只列 10 条。会话数真的很大时再考虑缓存
7. **未决：是否提供 `/wechat anchor up`**（自动创建 workspace + pane + `pi -c`）。能省掉手工步骤，但要自动创建 Herdr 工作区并注入 `pi -c`，属于"改用户环境"的动作，先不做
