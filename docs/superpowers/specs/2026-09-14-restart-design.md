# `/restart` 与 `/restart-all` 扩展设计

设计日期：2026-09-14。前置事故与修复见「背景」。

## 背景

2026-09-14，`extensions/auto-hide-thinking.ts` 的 `handleEvent` 包装器因为两个扩展（它和
`extensions/scroll-to-last-prompt.ts`）同时包装 `InteractiveMode.prototype.handleEvent`、
`/reload` 卸载顺序不同，产生了「没人认领的旧包装器」；下一次安装把自己的旧包装器当成 original
再包一层，而包装器内部又动态读 `state.originalHandleEvent`，于是自己调自己 → `RangeError:
Maximum call stack size exceeded` → pi 以 uncaughtException 退出（现场：w5:p9、w5:pC）。

根因已在 `a9d2bd7` 修掉（闭包捕获 original + 卸载后透传 + 拆不掉时不清记录）。但**已经被污染的
内存救不回来**：原型上那条坏链还在，修复版代码会把它当成 original 再包一层，照样爆栈 —— 已用
最小复现脚本实测确认（旧代码 100% `RangeError`；在「旧代码坏链 + 修复版代码」的进程里同样
`RangeError`）。

`/reload` 只替换扩展代码、**不换进程**，清不掉内存里的坏链；pi 也没有内置的「重启进程」命令
（只有 `/quit` 退出）。用户当时开着 12 个 pi 窗口，一个个手动退出再重进很烦。

因此本设计补上一对与 `/reload` 对称的命令：

| 已有 | 新增 |
|---|---|
| `/reload`（重载本窗口的扩展，不换进程） | `/restart`（重启本窗口进程，回同一个对话） |
| `/reload-all`（批量重载空闲窗口） | `/restart-all`（批量重启空闲窗口） |

## 目标

- `/restart`：一条命令重启**本窗口**，起来后仍是**同一个对话**。
- `/restart-all`：重启 Herdr 里所有「空闲 + 输入框为空」的**其他** pi 窗口，各自回各自的对话；
  忙碌 / 有草稿 / 状态不明 / 没有会话记录的窗口一律跳过，并留下可回看的报告。

## 范围

- 只在 Herdr 环境（`HERDR_ENV === "1"` 且有 `HERDR_PANE_ID`）生效；其他环境拒绝执行并说明原因。
- 不做「重启指定的某个其他窗口」（YAGNI，`/restart-all` 全量即可）。
- 不改变 `/reload-all` 的既有行为与既有报告的渲染结果（只新增一个可选字段）。

## 技术依据

全部结论来自 pi 0.85.1 / herdr 的实际源码与运行输出。

**A. `ctx.shutdown()` 是官方退出入口**

```
dist/core/extensions/types.d.ts:241    /** Gracefully shutdown pi and exit. Available in all contexts. */
dist/core/extensions/types.d.ts:209    export interface ExtensionContext {
dist/core/extensions/types.d.ts:254    export interface ExtensionCommandContext extends ExtensionContext {
dist/core/extensions/types.d.ts:1274   shutdown: () => void;   // ExtensionContextActions
```

命令处理器拿到的是 `ExtensionCommandContext`，因此命令里可以直接 `ctx.shutdown()`，干净退出
（会话已存盘）。

**B. 自己的会话文件：不用问 herdr**

`ctx.sessionManager.getSessionFile()`（`dist/core/session-manager.d.ts:209`，且
`ReadonlySessionManager` 显式暴露它，`types.d.ts:140`）。herdr 自己的集成文件用的也是同一个
调用：`~/.pi/agent/extensions/herdr-agent-state.ts:75`。

**C. 其他窗口的会话文件：Herdr 已经记着**

`herdr pane list` → `result.panes[].agent_session`，pi 窗口是 `{ agent: "pi", kind: "path",
value: "<绝对路径>.jsonl" }`。实测 12 个 pi 窗口全部给出路径。

刷新时机（herdr-agent-state.ts）：`updateSessionRef()`（:73）在 **`session_start`（:232）** 和
**每次 `agent_start`（:243）** 都重新取值，并用 `pane.report_agent_session`（:118）上报。
所以它记录的是「该窗口当前正在用的那个会话」，会随 `/resume` 等切换更新。

**D. `/quit` 是干净退出，且要求整条命令精确匹配**

```js
// dist/modes/interactive/interactive-mode.js:2496
if (text === "/quit") { this.editor.setText(""); await this.shutdown(); return; }
```

因为是 `=== "/quit"`，输入框里若已有草稿，注入的 `"<草稿>/quit"` 不会被当命令执行 ——
这就是必须先做输入框检测（沿用 `detect.ts`）的原因。

**E. `herdr pane run` 的语义与引号**

`herdr --skill` 原文：*"`pane run` atomically sends command text and Enter."*，示例是
`herdr pane run <pane-id> "just test"` —— **含空格的命令作为「一个参数」传入**。
因此本设计总是把整条命令拼成一个显式带引号的字符串再传：
`herdr pane run <pane> 'pi --session "<路径>"'`，路径含空格/中文也不会被 shell 拆开。

**F. 判断「对方是否已退到 shell」**

`herdr pane process-info --pane <id>` → `result.process_info.foreground_processes[].argv0`。
实测 pi 窗口是 `{"argv0":"pi", ...}`；pi 退出后前台进程变成 shell。重启流程靠它确认「可以安全
注入 `pi` 了」，避免把文本灌进 pi 的编辑器。

**G. `pi --session <path|id>` 是「继续写这个会话」而不是新建**

`pi --help`：`--session <path|id>  Use specific session file or partial UUID`；复制成新会话是
`--fork`。所以 `pi --session <原文件>` 起来后还是同一个对话、同一个 `.jsonl`。

**H. 分离助手能活过我退出**

`child_process.spawn("/bin/sh", [...], { detached: true, stdio: "ignore" })` + `child.unref()`：
POSIX 下 detached 会让子进程 `setsid` 成为新进程组组长，父进程退出不会带走它；stdio 忽略避免
写已关闭的 fd。助手输出重定向到 `~/.pi/agent/restart.log`，便于事后排查。

## 架构

```
extensions/restart.ts                    新增，单文件、零依赖
  └─ /restart                            命令：守卫 → waitForIdle → 分离助手 → shutdown

extensions/reload-all/index.ts           改动
  ├─ /reload-all                         行为不变（目标筛选抽到 plan.ts）
  ├─ /restart-all                        新增：扫 pane → 逐个 restartPane() → 报告
  ├─ plan.ts                             新增，纯函数 classifyPane()（可单测，不依赖 pi）
  ├─ plan.test.ts                        新增单测
  └─ restart-pane.ts                     新增：重启一个窗口的 TS 版四步原语
```

**两个扩展零交叉依赖**：`reload-all/index.ts` 只 import 同目录的 `plan.ts` / `restart-pane.ts`；
`restart.ts` 不 import 仓库里任何其他文件。

一开始的设计是反向的（`reload-all` import `../restart.ts`），实现时被实测否掉了 —— 2026-09-15
在一个测试窗口里启动 pi 直接失败：

```
Error: Failed to load extension "/Users/jiezhou/.pi/agent/extensions/reload-all/index.ts":
Failed to load extension: Cannot find module '../restart.ts'
```

即：**让已装的扩展依赖未装的新文件，会把整个 pi 拖死**。改成同目录后，两个扩展可以各自
单独安装、单独升级。

**一处必须承认的重复**：「重启某一个窗口」的四步序列有两份实现 —— TS 版
（`reload-all/restart-pane.ts`，给 `/restart-all` 用）和 Shell 版（`restart.ts` 里的分离助手，
给 `/restart` 用）。Shell 版只服务于「自己」这一种情况，因为它必须在「本进程已经不存在」之后
才能执行。改超时/改步骤时两处必须一起改。

**环境假设**：分离助手继承 pi 的环境，因此 `PATH` 里必须有 `herdr`（本机为
`/opt/homebrew/bin/herdr`）。

## 共用原语：重启「某一个窗口」

`restartPane(pi, { paneId, sessionRef })`（实现位于 `extensions/reload-all/restart-pane.ts`，
由 `/restart-all` 调用）依次做四步，**任一步失败就返回失败，不再继续**：

1. 前置校验：`paneId`、`sessionRef` 均非空（任一为空视为失败，绝不猜）。
2. 退出：`herdr pane run <paneId> "/quit"`（超时 2s）。
3. 等它退到 shell：轮询 `herdr pane process-info --pane <paneId>`，直到 `argv0 !== "pi"`
   （最长 10s，步长 100ms）。超时 = 失败，**不执行第 4 步**。
4. 重启：`herdr pane run <paneId> 'pi --session "<sessionRef>"'`（超时 2s）。

设计取舍：第 3 步是「宁可不重启，也不污染」的闸门。若某窗口因为任何原因没退干净，我们只是
少重启一个窗口，而不是往它的输入框里灌一行文本。

## 命令行为

### `/restart`（本窗口）

0. 自己不使用 `restartPane()`：那四步里的第 3、4 步必须在「本进程已经不存在」之后执行，所以由
   分离助手用 Shell 重演同一个序列（见上）。
1. 守卫：非 Herdr、或 `ctx.sessionManager.getSessionFile()` 为空 → `ctx.ui.notify(..., "error")`
   并**直接返回**（不退出，不做半套操作）。
2. `await ctx.waitForIdle()`：避免打断进行中的回合（扩展命令在流式中也会立即执行）。
3. 启动分离助手（见下）；`spawn` 抛错 → 报错并返回（**不** `shutdown`）。
4. `ctx.ui.notify("正在重启本窗口…")`（进程马上就没，纯尽力而为）。
5. `ctx.shutdown()` —— 终止操作，之后不再有任何逻辑。

助手脚本（`/bin/sh`；父进程通过 `spawn` 的 `env` 传入 `PI_PID` / `PANE_ID` / `SESSION_FILE` /
`RESTART_LOG` 四个环境变量，避免往命令行里拼字符串）：

```sh
exec >>"$RESTART_LOG" 2>&1
# 1) 等本窗口的 pi 进程消失（pid 由父进程传入）
i=0; while [ $i -lt 200 ]; do kill -0 "$PI_PID" 2>/dev/null || break; sleep 0.1; i=$((i+1)); done
sleep 0.5
# 2) 再用 herdr 确认前台已经不是 pi（双保险）
i=0; while [ $i -lt 50 ]; do
  herdr pane process-info --pane "$PANE_ID" | grep -q '"argv0":"pi"' || break
  sleep 0.1; i=$((i+1))
done
# 3) 用同一个会话把它拉起来
herdr pane run "$PANE_ID" "pi --session \"$SESSION_FILE\""
```

### `/restart-all`（所有空闲的其他窗口）

1. 守卫：非 Herdr → 与 `/reload-all` 相同风格的报错返回。
2. 扫描 + 过滤，完全复用 `/reload-all` 的既有逻辑：
   - 目标：`agent === "pi"`、`paneId !== 自己`、`agent_status === "idle"`、输入框 `empty`、
     `agent_session.value` 非空；
   - 跳过并记原因：`busy`（工作中）、`draft`（有草稿）、`unconfirmed`（状态未确认/检测失败）、
     新增 `no-session`（Herdr 里没有会话记录）。
3. 对每个目标**并行**调用 `restartPane()`；单个窗口失败不影响其他窗口。
4. `pi.appendEntry(...)` 写报告 + `ctx.ui.notify(...)`。
5. **不**调用 `ctx.reload()`：执行者自己没有被重启，也不需要换代码。

## 报告

沿用 `reload-all-report` entry 类型与渲染器，只新增一个**可选**字段：

```ts
type ReportData = {
  at: string;
  command?: string;   // "/reload-all"（缺省，兼容历史 entry）| "/restart-all"
  sent: unknown[];
  failed: unknown[];
  skipped: unknown[];
};
```

- 标题行：有 `command` 用 `command`，否则维持 `/reload-all`。
- 汇总动词：`/restart-all` 用「已重启 N」，缺省维持「已重载 N」。
- 跳过原因 `no-session` 的文案：「Herdr 里没有会话记录」。
- 历史 entry（无 `command`）必须原样渲染 —— 与现有「三种历史形态都容错」的做法一致。

## 错误处理

| 环节 | 失败表现 | 行为 |
|---|---|---|
| `/restart` 非 Herdr | `HERDR_ENV !== "1"` / 无 pane id | 报错返回，**不退出** |
| `/restart` 无会话文件 | `getSessionFile()` 为空 | 报错返回，**不退出** |
| `/restart` spawn 助手失败 | 抛错 | 报错返回，**不退出** |
| `/restart-all` 某窗口读不到会话路径 | `agent_session` 缺失 | 跳过，记 `no-session` |
| 第 2 步注入 `/quit` 失败 | herdr 退出码非 0 | 该窗口记失败，继续下一个 |
| 第 3 步等 shell 超时 | 10s 内 `argv0` 仍是 `pi` | 该窗口记失败，**不注第 4 步** |
| 第 4 步注入 `pi` 失败 | herdr 退出码非 0 | 该窗口记失败（此时窗口停在 shell，可手动敲 `pi`） |

## 测试

- **单测（纯函数）**：把 `/reload-all` 里内联的「扫描 + 过滤」小幅抽成纯函数（不改行为，沿用
  `index.ts` 已导出 `reportLines` 做测试的先例），新增「从 pane 列表 + 编辑器状态推导目标/跳过」的
  单测，覆盖五种情形：正常目标、忙碌、有草稿、无会话记录、是自己。
- **单测（复用）**：`extensions/reload-all/detect.test.ts` 不动。
- **手动验收**（用小号测试窗口，**不拿正在聊天的窗口试**）：
  1. `pi -e ./extensions/restart.ts` 起一个测试窗口 → `/restart` → 窗口自己回来且对话还在；
  2. 在该测试窗口跑 `/restart-all` → 其他空闲窗口各自回到自己的对话；忙碌/有草稿的被跳过；
  3. 制造「Herdr 没有会话记录」的窗口 → 确认被跳过，而不是起成新对话；
  4. 检查 `~/.pi/agent/restart.log` 有无异常。

## 实现后的验收结果（2026-09-15）

- 单测：`cd extensions/reload-all && npm test` → `tests 20 / pass 20 / fail 0`
  （13 个原有的输入框检测 + 7 个新增的 `classifyPane` 判定）。
- 实测引号语义（w5:pF，废弃窗口）：`printf "[%s]\n" "a b" "c"` 与 `ls "/tmp/sp ace"` 都按预期
  执行 —— herdr 把整条命令原样发进 shell，引号由目标 shell 解析。
- 实测分离助手能活过父进程退出（`spawn` detached + `unref`，父进程 `process.exit(0)` 后 2s 仍写入文件）。
- 实测四步原语（w5:pF）：`/quit` → 第 2 次轮询前台变成 `fish` → `pi --session "<原路径>"` →
  `pane list` 里 session 与重启前**完全相同**。
- 实测 `/restart` 端到端（一次性测试窗口 w5:pG，用 `pi -e ./extensions/restart.ts` 加载）：
  `~/.pi/agent/restart.log` 记录 `helper start` → `relaunch: pi --session …` → `helper done exit=0`，
  重启后 `pane list` 的 session 与重启前完全相同。
- 批量命令 `/restart-all` 的逐窗口行为依赖真实的多窗口环境，留作人工验收（见「测试」一节）。

## 安装与文档

- `/restart` 是单文件扩展：需要把 `extensions/restart.ts` 软链/复制到 `~/.pi/agent/extensions/`
  （与 `commits.ts` 等一致）。
- `reload-all/` 已经是目录型扩展，无需重新链接（新增的 `plan.ts` / `restart-pane.ts` 都在目录内）。
- 两者互不依赖，**单独装、单独升级都可以**（见「架构」里的实测教训）。
- README：新增 `/restart` 一行；把 `reload-all/` 一行改成「`/reload-all`、`/restart-all` ——
  批量重载 / 重启空闲窗口」。

## 非目标

- 不做「重启指定的某个窗口」（没有 `--pane` 参数）。
- 不做非 Herdr 的降级方案：没有 herdr 就无法往别的窗口写输入，也无法在本窗口退出后把自己拉起来。
- 不动 `/reload` / `/reload-all` 的语义，也不试图用 `/restart` 取代它们：
  `/reload` 是热重载（快、不换进程），`/restart` 是换进程（慢、但能清干净内存）。

## 风险与未决

1. **分离助手是本设计唯一的进程外环节**：若 spawn 被环境禁止或被系统清理，本窗口退出后不会自动
   回来（停在 shell，需手敲 `pi`）。缓解：助手启动失败时 `/restart` 直接报错、不退出；助手自身
   输出写 `~/.pi/agent/restart.log`。
2. **`herdr pane run` 的引号行为需实测一次**：依据是 `--skill` 的示例（整条命令一个参数）。
   实现时先在一个废弃窗口上验证 `pi --session "<路径>"` 能被正确解析。
3. **并行重启 10+ 个窗口**会同时发生 10 次退出 + 启动。若实测有卡顿，改为分批（每批 3~4 个）。
4. **忙碌判定**依赖 `agent_status` 与屏幕检测，边界与 `/reload-all` 相同（已知且可接受）。
5. `/restart` 期间用户看不到任何反馈（进程即将退出）；这是「重启」的固有代价，报告只在
   `/restart-all` 里给。
