# `/reload-all` 扩展设计

## 目标

一条命令把 Herdr 里所有空闲的 pi 窗口全部重载一遍，替掉"逐个窗口敲 `/reload`"的手工流程。

动机：本机常态开着 11 个 pi pane（实测 `herdr agent list`），改完扩展 / 主题 / skills / 上下文文件后要挨个重载，成本随窗口数线性增长。

## 范围

**做：**

- 注册 `/reload-all` 斜杠命令
- 广播 `/reload` 给所有空闲的 pi pane（不含自己）
- 报告：成功数 + 跳过清单（带原因）
- 最后重载自己（`ctx.reload()`）

**不做：**

- 不做全局重启。`models.json` 的重读只在启动路径上发生（见「技术依据」），本命令不解决它，也不假装解决
- 不等待忙碌窗口空闲后补发
- 不注册成给 LLM 调用的 tool

## 技术依据

全部结论来自 pi 0.1.69 与 herdr 的实际源码 / 运行输出。

**A. Herdr 环境判定与自识别**

沿用 `extensions/auto-hide-thinking.ts` 已验证的写法：

```ts
const ENABLED = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
```

`HERDR_PANE_ID` 即当前 pane 的 id，用来把自己从广播目标里排除。

**B. 调 herdr 的方式**

```ts
await pi.exec("herdr", ["pane", "list"], { timeout });
await pi.exec("herdr", ["pane", "run", paneId, "/reload"], { timeout });
```

`herdr pane run` 的官方语义（`herdr --skill`）：*"`pane run` atomically sends command text and Enter."* 文本与回车一次发完，不需要再补 `send-keys Enter`。

`herdr pane list` 输出 JSON，`result.panes[]` 含 `pane_id` / `agent` / `agent_status` / `cwd` / `tab_id` / `workspace_id`。

**C. `ctx.reload()` 是程序化入口**

`docs/extensions.md:1302`：

```ts
pi.registerCommand("reload-runtime", {
  handler: async (_args, ctx) => { await ctx.reload(); return; },
});
```

文档硬性要求：

> For predictable behavior, treat reload as terminal for that handler (`await ctx.reload(); return;`).

所以 `/reload-all` 的**报告必须打在 `ctx.reload()` 之前**。

**D. `/reload` 与 `models.json` 的关系（决定本命令的边界）**

`/reload` 走 `agent-session.js:2217 reload()`：`settingsManager.reload()` + `resourceLoader.reload()` + `_buildRuntime()`。其中 `_buildRuntime` 是 `new ModelRegistry(this._modelRuntime)` —— **复用同一个 modelRuntime 实例**。

`ModelRuntime.refresh()`（唯一会执行 `ModelConfig.load(modelsPath)` 的地方）只有两个调用者：

- `core/agent-session-services.js:98` —— `createAgentSessionServices()`，启动路径
- `modes/interactive/interactive-mode.js:4796` —— `completeProviderAuthentication()`，`/login` 流程

`/reload` 只读了一次 `modelRuntime.getError()`（`interactive-mode.js:5033`）用于报错。**结论：`/reload` 不重读 `models.json`。**

**E. 命令处理器是同步 `await` 的**

```
agent-session.js:829   const handled = await this._tryExecuteExtensionCommand(text);
agent-session.js:965   await command.handler(args, ctx);
```

处理器返回前，命令调用不算结束。但 TUI 不会冻结：`interactive-mode.js` 里没有 `isProcessing` / `setReadOnly` / 禁用编辑器的机制，工作指示器只由 `turn_start` 触发（`interactive-mode.js:2573-2583`），命令处理器不产生 turn。**即：长耗时处理器表现为"静默挂起、无任何反馈"，而不是界面冻结。** 这是本设计把广播保持在秒级的原因。

**F. 编辑器占用检测的屏幕依据**

`herdr pane read <pane_id> --source visible` 实测 4 个 pane（w2:p1 / w2:p2 / w3:p8 / w5:p1），空编辑器的渲染特征完全一致：

```
<最后一段对话内容>
                                          ← 空行
──────────────────────────────────────    ← 输入框上边线
                                          ← 输入框内容区（唯一的空行）
──────────────────────────────────────    ← 输入框下边线
🤖 01/grok-4.6-latest • 🧠 high • ...      ← footer 第 1 行
📈 (+0,-0) • ⏳ ...                        ← footer 第 2 行
```

取"屏幕上最后两条整行皆为 `─` 的长横线"，其区间即编辑器内容区。

**实测反例样本（w5:p7）**：该 pane 的输入框里真有一份未提交的草稿 `/wechat`，且因斜杠命令补全弹窗打开，下边线之后有 **4** 行：

```
──────────────────────────────────────    ← 上边线
/wechat                                   ← 草稿
──────────────────────────────────────    ← 下边线
→ wechat      [u:npm:pi-wechat-assistant] ...  ← 补全项
🤖 01/deepseek-v4.1-flash • ...            ← footer 第 1 行
🌿 main • 🔖 8ea6e31 • ...                 ← footer 第 2 行
[微信 ⏸ 未连接]                            ← 其它扩展的状态行
```

这份样本同时提供了两件事：`occupied` 分支的真实用例（已固化为 `detect.test.ts` 的回归用例），以及"下边线之后的行数"可达 4 —— 因此上限取 6，而不是最初假设的 2。

**G. 为什么不能用 `ctrl+u` / `ctrl+c` 代替检测**

`docs/keybindings.md`：

| 绑定 | 动作 | 可用性 |
|---|---|---|
| `ctrl+u` | `tui.editor.deleteToLineStart` | 多行草稿只能删当前行到行首，首行之前的内容清不掉，回车仍会提交残余 |
| `ctrl+c` | `app.clear` = **Clear editor (first) / exit (second)** | 编辑器已空时会**直接退出该窗口的 pi**，不可用 |

结论：无法靠按键安全清空，只能检测后跳过。

## 架构

无外部依赖，只依赖 `pi.exec` 与 `ctx.ui`。

**文件布局**：目录型扩展，对齐 `extensions/codex-usage/` 的形态（目录 + `package.json` 的 `pi.extensions`），以便把检测判据抽成可单测的纯函数。

```
extensions/reload-all/
  package.json      # name / private / type:module / scripts.test / pi.extensions
  index.ts          # 扩展入口：命令注册、herdr 调用、报告
  detect.ts         # 纯函数：屏幕文本 → empty | occupied | unknown
  detect.test.ts    # detect.ts 的单元测试
```

```
/reload-all
  │
  ├─ 门禁：HERDR_ENV !== "1" 或无 HERDR_PANE_ID → 报错并返回（不发、不 reload 自己）
  │
  ├─ ① herdr pane list                    → JSON
  ├─ ② 过滤 agent==="pi" && pane_id !== HERDR_PANE_ID
  ├─ ③ 并行：对每个候选做「状态 + 编辑器占用」判定并分类
  ├─ ④ 对分类为「发送」的目标并行执行 herdr pane run <pane> /reload
  ├─ ⑤ 报告（成功数 + 跳过清单）
  └─ ⑥ await ctx.reload(); return;
```

③ 与 ④ 并行而非串行：`pane run` 是本地 socket 调用，并发无压力；串行最坏情况是 N × 超时。

## 编辑器占用检测

```
输入：herdr pane read <pane> --source visible --format text 的全文
输出：empty | occupied | unknown

1. 按行切分，从后往前找整行只由 "─" 组成且长度 ≥ 20 的行，取最后两条 → 记为上边线 L1、下边线 L2（L1 在 L2 之前）
2. 找不到两条 → unknown
3. L2 之后（不计末尾空行）不得超过 6 行，否则 → unknown
   —— 这一步防止把对话里的两条分隔线误当成编辑器边框。取 6 的依据见「技术依据 F」
4. 取 L1 与 L2 之间的所有行
5. 全部为空白字符 → empty
6. 否则 → occupied
```

**fail-safe 规则：`unknown` 一律按「跳过」的方向处理**（不发送）。宁可漏发，不可污染草稿。

该判据的两个附带保护：

- 草稿里若含整行 `─`，它出现在两条边线**之间**，不影响"最后两条"的选取，判据仍成立
- 窗口若被 dialog 之类覆盖、渲染形态不符合上述结构，判据多半落入 `unknown` → 跳过，从而避免把 `/reload` 打进 dialog 的输入焦点

## 命令行为

### `/reload-all`

无参数。流程见「架构」。

### 待发送条目的分类

```
候选 = agent === "pi" 且 pane_id !== 自己
每个候选按顺序判定：
  agent_status !== "idle"  → 跳过，原因 busy
  检测结果 === "occupied"  → 跳过，原因 draft
  检测结果 === "unknown"   → 跳过，原因 unconfirmed
  检测结果 === "empty"     → 发送
```

## 错误处理

| 情形 | 行为 |
|---|---|
| 非 Herdr 环境 | `ctx.ui.notify` 报错，**不发送、不 reload 自己**。没有别的窗口可广播，假成功比报错更糟 |
| `herdr pane list` 整体失败 | 报错，**不 reload 自己**。什么都没做成，不该留下"看起来成功"的假象 |
| 个别 `pane run` 失败 | 计入失败清单，**仍然 reload 自己**。部分成功是真实的 |
| 零个发送目标 | 报告"没有可重载的其它窗口"，**仍然 reload 自己**（自己是 "all" 的一部分） |
| 检测抛异常 | 该 pane 记 `unknown` → 跳过 |

超时：`pane list` 与 `pane run` 均设 2s（对齐 `auto-hide-thinking.ts` 的 `SEND_TIMEOUT_MS = 2_000`）。

## 报告

```
✅ 已重载 8 个窗口
⏭️ 跳过 3 个：
   w3:pF  工作中           investment
   w5:p3  有未提交草稿      pi-extension
   w2:p2  状态未确认        jiezhou
```

三种跳过原因与判定一一对应：`busy → 工作中`、`draft → 有未提交草稿`、`unconfirmed → 状态未确认`。

跳过项给出 `pane_id`、原因、`cwd` 的 basename。同一 `cwd` 下有多个 pane（实测 investment 有 5 个），靠 `pane_id` 区分 —— 用户可在 Herdr 界面里按 pane id 定位。

**报告 vs 自身 reload 的冲突**：见「技术依据 C」，报告必须先于 `ctx.reload()`，因此存在被自身 reload 清掉的风险。该风险列入测试用例，若不满足则退化为 `ctx.ui.setWidget`（常驻 widget，非瞬时 toast）。

## 测试

沿用 `extensions/codex-usage/` 的测试基建 `node --experimental-strip-types --test ./*.test.ts`（见其 `package.json` 的 `scripts.test`）。检测判据抽成纯函数 `detect.ts`，由 `detect.test.ts` 直测：

**单元测试**（纯函数，喂固定屏幕文本）

1. 空编辑器（4 个 pane 的实测样例）→ `empty`
2. 编辑器内含单行草稿 → `occupied`
3. 编辑器内含多行草稿 → `occupied`
4. 草稿中含整行长横线 → 仍正确，不误判
5. 屏幕上不足两条横线 → `unknown`
6. 对话内容里含长的 `─` 分隔线、编辑器为空 → `empty`（不能把对话里的线当成边线）

**集成 / 手工测试**（必须真跑）

1. 9 个空闲窗口各自打印 `Reloaded keybindings, extensions, ...`
2. `~/.pi/acp.log` 新增 9 条 `[session] event=start`（b-c-p 的 `session_start` 处理器会写这条日志）
3. busy 的窗口被跳过且列在报告里
4. 当前窗口自己也 reload 了
5. 报告在自身 reload 之后仍然可读；若不可读则改 `setWidget`
6. **在某空闲窗口输入草稿但不提交 → 运行 `/reload-all` → 该窗口被列为跳过，且草稿原文完整保留**

第 6 条覆盖检测判据的 `occupied` 分支。实现阶段已在 w5:p7 上找到一个真实的草稿实例（草稿 `/wechat` + 斜杠命令补全弹窗），该屏已固化为 `detect.test.ts` 的回归用例；手工用例仍建议跑一次，因为它同时验证"跳过不发送"这个动作本身。

## 非目标

- **不做全局重启。** 见「技术依据 D」，`models.json` 只能在进程启动时重读，本命令不涉及
- **不做 `--dry-run`。** 用 `herdr agent list` 已可达到预览效果，不为此增加参数面
- **不等待 busy 窗口。** 已决定"跳过 + 报告"，用户可在 Herdr 界面直接看到各窗口状态，之后重跑本命令即可
- **不做草稿保留（抓屏还原后注回）。** 软换行、宽字符、多行、滚动位置都会让还原失真，正确性无法保证，收益只是一个便利命令
- **不做跨窗口确认回执。** 不做「信号文件 + `pi.sendUserMessage`」那套无注入方案 —— 它会让 busy 窗口变成"排队等待"而不是"跳过"，且发起方拿不到各窗口成功/失败，与已选定的 A 语义不符

## 风险与未决

1. **检测依赖渲染文本。** 主题、字号、宽字符、终端尺寸变化都可能让判据落入 `unknown`。已用 fail-safe（unknown 即跳过）把后果限制为"漏发"，不会造成破坏
2. **dialog 覆盖窗口时的行为未实测。** 预期落入 `unknown` 从而跳过，但若 dialog 打开时编辑器框仍被渲染，则 `/reload` 可能被打进 dialog 焦点。首次实测时纳入观察
3. **报告被自身 reload 清掉。** 测试用例 5 会暴露；退路是 `ctx.ui.setWidget`
4. **`herdr pane run` 的注入与用户手速竞争。** 检测到发送之间若用户恰好开始打字，仍可能碰撞。窗口极窄（毫秒级），接受
