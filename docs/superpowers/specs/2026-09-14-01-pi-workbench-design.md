# 01-pi-workbench：一条命令复刻本机 Ghostty + herdr + Pi 工具链

## 目标

把本机这套 Ghostty + herdr + Pi 的完整工作环境打包成一个 npm 包 `01-pi-workbench`，让同事在 **Apple Silicon Mac、已装 Homebrew 与 Node** 的前提下，用一条命令得到与我本机一致的环境：

```bash
npx -y 01-pi-workbench setup
```

覆盖范围限定为**三件套**：Ghostty、herdr、Pi（含我的扩展、skill、以及各自的行为类配置）。

### 为什么是全自动（方案 C）而不是只覆盖 Pi 侧

公司 90% 的人在用 codex 而不是 Pi。要推动 Pi 的采用，安装器必须能面向"从没用过 Pi 的人"，不能把"你自己先装好 Ghostty / herdr / Node / pi"当成前置条件——那一步就会劝退目标人群。所以安装器要负责装本体、写配置、装扩展、link 插件，最后只留"去 CC Switch 配 provider"这一件必须人工的事。

### 非目标

- 不改登录 shell（不装 fish、不 `chsh`）
- 不碰任何凭据类文件（`models.json`、`auth.json`、`web-search.json`）
- 不写 `defaultProvider` / `defaultModel`
- 不升级同事已有的工具（只补缺失）
- 不管 Claude Code / Codex CLI / Gemini CLI 的配置（那是 CC Switch 的地盘）
- 不做 Windows / Linux / Intel Mac 支持（平台检查会明确拒绝并给理由）

## 背景：本机现况盘点

打包内容的唯一真相来源是本机实际生效的状态，不是仓库里的副本。

| 层 | 位置 | 内容 |
|---|---|---|
| Ghostty 1.3.1 | `~/.config/ghostty/config.ghostty` | `theme = Light+`、`window-theme = light`、13 条 keybind（`home`/`end`/`page_up`/`page_down`/`numpad_1..9` 映射为 `csi:*;7*`） |
| Ghostty 主题 | `~/.config/ghostty/themes/Light+` | 475 B，自定义 `palette` 0–15 + 前景/背景/光标/选区 |
| Ghostty App Support | `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty` | 0 字节空文件 |
| herdr 0.9.0 | `~/.config/herdr/config.toml` | 顶层 `onboarding = false`；`[theme]` 的 `name = "tokyo-night-day"`、`auto_switch = false`；`[terminal]` 的 `default_shell = "/opt/homebrew/bin/fish"`（**仅从打包模板中排除，本机保留**）；`[keys]` 7 个键；`[[keys.command]]` 的 `prefix+d` |
| herdr 插件 | `~/.config/herdr/plugins/{pi-session-delete,tab-numbers}` | 均为 `python3` 脚本 |
| Pi 0.85.1 | `~/.pi/agent/settings.json` | `theme: light`、`tuiMode: fullscreen`、`hideThinkingBlock: false`、7 个第三方 pi 包、`defaultProvider: "01"` |
| 我的扩展 | `/Users/jiezhou/Desktop/公司其他/pi-extension/extensions/` | 见"包结构" |
| 我的 skill | `/Users/jiezhou/Desktop/公司其他/pi-extension/skills/read-terminal/` | `SKILL.md` + `scripts/find-pane.py` |
| CC Switch | `/Applications/CC Switch.app`、`~/.cc-switch/` | 独占 `~/.pi/agent/models.json`、`auth.json`、`settings.json` 的 provider 绑定 |

### 已确认的环境事实（本设计依赖）

- `herdr` 在 **homebrew-core**（无需第三方 tap）：`brew install herdr`
- `ghostty` 是官方 **cask**（要求 macOS ≥ 13）：`brew install --cask ghostty`
- Node 来自 **fnm**（`~/.local/bin/fnm`），非 brew
- Pi 官方安装方式：`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
- **Ghostty 同时读 `config` 与 `config.ghostty`，冲突时 `config.ghostty` 优先**（已用沙箱实验证实）；`config.ghostty` 是 1.3.1 的官方推荐名，也是 `super+,` / `ghostty +edit-config` 的目标文件
- **herdr 没有配置 include 机制**，也没有 `HERDR_CONFIG` 类环境变量；但提供 `herdr config check`（校验）与 `herdr server reload-config`（热重载）
- **CC Switch 直接管理 `~/.pi/agent/models.json`**（`models.json.bak-*` 是它留下的备份），且不碰 `auth.json` 和 `settings.json`
- `pi-footer` 的配置路径硬编码：`pi-footer/src/config.ts:34` 为 `join(getAgentDir(), "extensions", "pi-footer.json")`；`pi-context-view` 同样读 `<agent dir>/extensions/pi-context-view.json`，且语义是 overrides-only

## 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 入口 `npx -y 01-pi-workbench setup` | 唯一能同时触达 npm 生态、Homebrew、本地文件系统的入口。若将来连 Node 都没有，只需把入口换成 `curl \| bash` 引导脚本，setup 逻辑一行不用改 |
| D2 | 包名用非 scoped 的 `01-pi-workbench` | 打字短；npm 上未占用（已确认 404） |
| D3 | 完全不装 fish、不写 `default_shell`、不 `chsh` | 全配置 grep 只有 1 处提到 fish（`herdr config.toml` 的 `default_shell`）；Ghostty 未设 `command`；Pi 侧 0 引用；调用 python3 而非 fish。fish 是纯偏好不是依赖。且 `chsh` 需交互输密码，本就无法一键 |
| D4 | 不写 `models.json` | CC Switch 的地盘，我们写会跟它打架 |
| D5 | 不写 `defaultProvider` / `defaultModel` | 同事没配 `01` 时 pi 起不来。这两个字段交给 CC Switch / 用户 |
| D6 | 主题改名 `01-pi-workbench-light` | `Light+` 是整文件主题（`Light+ (user)`），同名会覆盖同事的主题。配色一字不改，只改名 |
| D7 | Ghostty 写 `config.ghostty`，不写 `config` | 官方推荐名 + 优先级更高（能盖住同事遗留 `config` 的旧值）+ 不与遗留文件互踩 |
| D8 | herdr `[theme].name` 归"我们赢" | 否则拿不到这套观感 |
| D9 | `postinstall` 不干重活 | `pi install` 底层是 `npm install`，`pi update --extensions` 会重新触发。postinstall 只在未 setup 时打印一行提示，保证 `pi update` 永远安全、瞬时 |
| D10 | pi 版本门槛 `>= 0.85.1`，超门槛则停止并提示升级，附 `--force-skip-version-check` | 本套用到 `pi.appendEntry` / `pi.registerEntryRenderer` / `pi.exec` / `@earendil-works/pi-ai/providers/all`，pi 太老会加载即失败；但不自动升级以不打乱同事环境 |
| D11 | 不 pin 包版本（写 `npm:01-pi-workbench` 而非 `@0.1.0`） | 让 `pi update --extensions` 能拿到新版 |
| D12 | `uninstall` 默认做"减法"而非整文件回滚 | 整文件回滚会连带丢掉同事在 setup 之后自己做的改动，那是更严重的破坏。`--restore-backup` 才走回滚并要求二次确认 |
| D13 | 仓库根即包根，复用现有 `extensions/` 与 `skills/` | 这两个目录名**正好就是 pi 包的约定目录**，无需搬运，零重复 |
| D14 | `pi` 清单**显式列举**每个扩展，不用目录通配 | 防止 pi 递归扫到 `codex-usage/parser.ts`、`format.ts` 等辅助文件并当成扩展加载 |
| D15 | 两个 JSON 以**实际安装版**为准，并加 dev 脚本回同步 | 仓库副本已过期：`pi-footer.json` 少了 `codex-usage-event` widget 与 `hiddenKeys`；`pi-context-view.json` 还是硬编码 hex（实际已迁到 `mdHeading` / `syntaxFunction` 等主题令牌）。按仓库发会导致配色崩坏 |
| D16 | 排除 `startup-sync.ts` | 它依赖 `~/.pi/agent/scripts/backup.sh`（我个人的 LaunchAgent 备份脚本，不在仓库里）。我自己也已不再安装它 |
| D17 | 纳入 `onboarding = false` 的管理 | 否则同事首次启动看到 herdr 引导页；机制与其它顶层键相同，边际成本近零 |
| D18 | herdr 插件先复制到稳定目录再 `link` | 直接从 npm 缓存目录 link，包更新/重装后 link 会断 |
| D19 | 平台硬校验 `darwin/arm64` + macOS ≥ 13 | 本设计只在 Apple Silicon 上被验证过 |
| D20 | 纳入 `scroll-to-last-prompt.ts` | 它在仓库里且有独立设计文档，属于这套工作流的一部分；本机未装只是因为今天才写完。纳入后我会用本地路径安装自己 dogfood，从而让本机与同事环境重新一致 |
| D21 | `--adopt` 把冲突扩展移到 `~/.pi/agent/extensions.disabled/` | 该目录不是 pi 的加载路径，移入即失效，同时保留文件便于同事随时取回 |

## 包结构

仓库根即包根：

```
pi-extension/                     # 仓库根 = npm 包根
├── package.json                  # name: 01-pi-workbench, bin, files, pi 清单
├── README.md / CHANGELOG.md      # README 需重写，覆盖新范围
├── bin/cli.mjs                   # 唯一入口：setup / doctor / uninstall
├── src/
│   ├── detect.mjs                # 探测 brew/node/npm/python3/pi/ghostty/herdr + 已装 pi 包
│   ├── tools.mjs                 # brew 依赖编排（只补不升）
│   ├── piinstall.mjs             # pi 版本门槛 + pi install/remove 封装
│   ├── settings.mjs              # settings.json 字段级增量
│   ├── jsonmerge.mjs             # "只加不覆盖"JSON 合并
│   ├── ghostty.mjs               # 标记块写 config.ghostty + 复制主题
│   ├── herdr.mjs                 # 文本级 TOML 合并 + 插件稳定副本 + link
│   ├── report.mjs                # 收尾报告 + diff 渲染
│   └── util/{backup,marker,toml-text,log}.mjs
├── assets/                       # 只被 setup 写盘，不由 pi 加载
│   ├── ghostty/config.ghostty    # 完整文件：标记块内含 theme/window-theme/13 条 keybind
│   ├── ghostty/themes/01-pi-workbench-light
│   ├── herdr/config.fragment.toml  # 待合并片段，含三部分：
│   │                               #   top            = 顶层键（onboarding）
│   │                               #   [keys]         = 要并入同事 [keys] 表的键
│   │                               #   [[keys.command]] = 追加到文件末尾的命令块
│   ├── herdr/plugins/{pi-session-delete,tab-numbers}/
│   ├── pi-footer.json            # 从 ~/.pi/agent/extensions/ 同步（含 codex-usage-event）
│   └── pi-context-view.json      # 从 ~/.pi/agent/extensions/ 同步（主题令牌版）
├── extensions/                   # 由 pi 加载，零写入
│   ├── auto-hide-thinking.ts
│   ├── checkpoint.ts
│   ├── codex-usage/              # 目录型扩展（含自身 package.json）
│   ├── commits.ts
│   ├── model-filter.ts
│   ├── reload-all/               # 目录型扩展
│   ├── scroll-to-last-prompt.ts
│   ├── steer-or-interrupt.ts
│   └── token-speed.ts
├── skills/read-terminal/
└── docs/superpowers/specs/
```

**不打包**：`extensions/startup-sync.ts`（D16）、`herdr-agent-state.ts`（由 herdr 自动生成并管理，重装集成会被覆盖）。

**关键分界线**：`extensions/` + `skills/` 走 pi 的包加载机制（**零文件写入**，不进 `~/.pi/agent/extensions/`）；`assets/` 里的东西**必须由 setup 写盘**，因为包加载机制够不着（最典型的是两个 JSON，路径硬编码在 `pi-footer` / `pi-context-view` 源码里）。物理分目录以区分这两类。

## 安装流程

### Phase 0 — 前置检查（纯只读）

1. 平台 `darwin` + `arm64`，macOS ≥ 13 → 否则拒绝并说明理由
2. 探测 `brew` / `node` / `npm` / `python3` / `pi` / `ghostty` / `herdr`
3. `python3` 单独报：两个 herdr 插件与 `read-terminal` skill 都依赖它
4. 打印"将要做什么"清单；`--dry-run` 到此结束

### Phase 1 — 全局工具（只补不升）

- `brew install herdr`（homebrew-core）
- `brew install --cask ghostty`
- 已有则跳过，**永不升级**
- **不装 fish**

### Phase 2 — pi 本体

- 缺失 → `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`
- 存在 → 比版本门槛（D10），不足则停止并给明确升级命令

### Phase 3 — pi 包

- `pi install npm:01-pi-workbench`（幂等，pi 按包名去重）
- 检测 `~/.pi/agent/extensions/` 里的**重复注册风险**（同名扩展既以真文件/软链存在，又由 pi 包提供）→ **只列出，不擅自删**，建议 `--adopt` 把它们移入 `~/.pi/agent/extensions.disabled/`（D21）

### Phase 4 — 配置文件（每小步先备份、可单独跳过）

| 步骤 | 目标 | 策略 |
|---|---|---|
| 4a | `~/.pi/agent/extensions/pi-footer.json`、`pi-context-view.json` | "只加不覆盖"JSON 合并 |
| 4b | `~/.pi/agent/settings.json` | 字段级增量；`defaultProvider/Model` 绝不写 |
| 4c | `~/.config/ghostty/config.ghostty` + `~/.config/ghostty/themes/01-pi-workbench-light` | 标记块 + 复制主题文件 |
| 4d | `~/.config/herdr/config.toml` + 两个插件 | 文本级 TOML 合并 + 稳定副本 + `herdr plugin link` |

### Phase 5 — 收尾报告（见下）

## 合并策略：逐资产

### 1. 扩展与 skill —— 零文件写入

`pi install npm:01-pi-workbench` 让 pi 从 `~/.pi/agent/npm/` 加载，`~/.pi/agent/extensions/` 完全不碰。

**重复注册风险**：若同事曾手工拷过同名扩展，pi 会同时加载两份，`/commits` 之类会注册两次并冲突。setup 检测并列出，`--adopt` 才动手。

### 2. `settings.json` —— 字段级增量

- `packages`：交给 `pi install` 追加去重，**不手写 JSON**
- `theme` / `tuiMode` / `hideThinkingBlock`：**仅缺失时补默认值**，同事自定义过就不抢
- `defaultProvider` / `defaultModel`：**绝不写**（D5）
- `auth.json` / `models.json` / `sessions/` / `models-store.json`：**完全不碰**

### 3. 两个 JSON —— "只加不覆盖"

```
merge(defaults, existing):
  for k in defaults:
    if k 不存在于 existing:   existing[k] = defaults[k]   # 缺 → 补
    elif 两边都是普通对象:      recurse                     # 递归
    else:                     保持 existing                # 同事赢（数组整体当值）
```

- **不排序键**，新键追加末尾 → 天然幂等
- `pi-footer.json` 的 `lines`（数组）、`extensionStatusRow.hiddenKeys` / `knownKeys` 都是数组 → **整体当值**，同事有就全留，不拆不并（避免并集造出重复 widget）
- 序列化 `JSON.stringify(v, null, 2)` + 结尾换行，避免格式抖动产生假 diff
- 修改前备份 `.bak-<时间戳>`

### 4. Ghostty —— 标记块

`~/.config/ghostty/config.ghostty` 里追加：

```
# >>> 01-pi-workbench >>>
theme = 01-pi-workbench-light
window-theme = light
keybind = home=csi:1;7D
...（13 条）
# <<< 01-pi-workbench <<<
```

- 无块 → 追加；有块 → 正则替换整块
- `config.ghostty` 优先级高于 `config`，所以块内同键"我们赢"；同事的字体、透明、shell 集成、自定义 keybind **全部保留**
- 主题文件复制到 `themes/01-pi-workbench-light`；同名且内容相同则跳过，不同则备份后覆盖
- 报告里**检测并提示**：同事的 `config` 里若也有 theme/keybind，明确告知"这些会被 `config.ghostty` 覆盖"
- `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`：**仅检测，非空就提示，绝不擅自写**（该目录的跨目录优先级未经实验确认）

### 5. herdr `config.toml` —— 文本级合并（保住注释）

**为什么不能**"解析 → 改 → 重新序列化"：TOML 库会丢掉同事全部注释（我这份就有 4 处）。
**为什么不能**"末尾追加标记块"：TOML **禁止重复定义 `[keys]` 表**，会导致整文件解析失败。

流程：

1. **前置基线**：先跑 `herdr config check`。若同事配置本就损坏 → 立即停手，不碰他的文件
2. 定位 `[keys]` 区间：从 `^\[keys\]` 起，到下一个顶级表头（`^\[` / `^\[\[`）或 EOF
3. 解析该区间已有键名做冲突检测 → 同名键**默认不插**，报告列为"已跳过（你已自定义）"；`--force` 才覆盖
4. 标记块插到该区间**末尾**（即紧邻 `[[keys.command]]` 之前——TOML 要求 `[keys]` 的标量键必须出现在数组表之前）
5. `[[keys.command]]`（`prefix+d` 删会话）追加到**文件末尾**，按 `key =` 去重
6. `onboarding = false` 插到**第一个表头之前**的顶层区（D17）
7. `[theme].name` 是"我们赢" → 走**行替换**（存在则改值，不存在则建表）
8. 写回后**立刻 `herdr config check`**：不通过 → **自动还原备份 + 报错退出**
9. `herdr server reload-config` 热重载（**无需重启 herdr**）

`[terminal].default_shell` **不写**（D3）；若同事已有该键也**不动**。

### 6. herdr 插件 —— 官方 link + 稳定副本

`plugins.json` 由 herdr 自己管理（含绝对路径、`source.kind`），手改容易写坏 → 用官方 `herdr plugin link <PATH>`。

**不能**直接从 npm 包目录 link：npm 更新/重装后目录消失，link 会断。→ 先复制到稳定位置 `~/.local/share/01-pi-workbench/herdr-plugins/<id>/`，再从那里 link。更新时只刷新这份副本，link 不变。

同事已有同名 `local.pi-session-delete` / `local.tab-numbers` → 检测到就跳过并告知。

### 7. 明确不碰

`~/.pi/agent/auth.json`、`models.json`、`sessions/`、`models-store.json`、`~/.cc-switch/`、`~/.zshrc`、`~/.ssh`、`~/Library/Application Support/com.mitchellh.ghostty/`

## 幂等

| 步骤 | 幂等机制 |
|---|---|
| brew 工具 | `brew list --versions` 探测，有则跳过，永不升级 |
| pi 本体 | `pi --version` 解析后比门槛 |
| pi 包 | pi 按包名去重；不 pin 版本（D11） |
| `settings.json` | 只补缺失字段 |
| 两个 JSON | "只加不覆盖"，新键追加末尾 |
| Ghostty | 标记块正则替换 |
| herdr | 文本插入 + `[[keys.command]]` 按 `key` 去重 |
| herdr 插件 | 同名跳过；更新只刷新副本，link 不动 |
| 主题文件 | 同名同内容跳过 |

**幂等金标准**：对同一份 fixture 连跑两次 `setup`，第二次必须**零字节变化**，报告状态从"已完成"变为"已是目标状态"。此条直接作为自动化测试用例。

## 备份与回滚

- **备份位置：同目录 + `.bak-<时间戳>`**，与已有的 `models.json.bak-20260914-104227` 风格一致。不用集中目录——否则同事出事时找不到
- 每次运行前统一备份"将要改的文件"，报告列出清单
- **`uninstall` 默认做减法**（D12）：删标记块、删我们管的键、`herdr plugin unlink` + 删稳定副本、`pi remove`、删我们加的主题文件
- `--restore-backup` 才整文件回滚，且要先列出将覆盖哪些文件、要求二次确认

## 收尾报告

```
✅ 已完成
   herdr 0.9.0                    已是目标版本，跳过
   Ghostty 1.3.1                  brew install --cask ghostty
   pi 0.85.1                      已是目标版本
   pi 包                          pi install npm:01-pi-workbench
   扩展 ×9 / skill ×1             由 pi 包加载，零写入
   pi-footer.json                 新增 3 键，保留你的 2 键
   ghostty config.ghostty         标记块写入 13 条 keybind
   herdr config.toml              [keys] +7 键，[[keys.command]] +1 条
   herdr 插件 ×2                  link → ~/.local/share/01-pi-workbench/herdr-plugins/

⏭️  已跳过
   [[keys.command]] prefix+d      你已有同名 command，未改动
   ~/.pi/agent/extensions/commits.ts
                                  检测到与 pi 包重复注册，未处理（见下方建议）

⚠️  改动了你已有的值（2 处，已备份）
   herdr [theme] name      "dracula"  →  "tokyo-night-day"
   ghostty theme           "Dracula+" →  "01-pi-workbench-light"

📋 需要你手动做
   1. 去 CC Switch 配 provider（models.json / auth.json 我们全程没碰）
   2. 重载 Ghostty：super+shift+,
   3. herdr 已自动热重载；若没生效：herdr server reload-config
   4. 在 pi 里执行 /reload

🔒 全程未触碰
   ~/.pi/agent/{auth.json,models.json,sessions/} · ~/.cc-switch/
   ~/.zshrc · ~/.ssh · ~/Library/Application Support/com.mitchellh.ghostty/

📦 备份（可删）
   ~/.config/ghostty/config.ghostty.bak-<ts>
   ~/.config/herdr/config.toml.bak-<ts>
   ~/.pi/agent/extensions/pi-footer.json.bak-<ts>

退出码：0 全部成功 · 1 有跳过 · 2 有失败
```

## 测试策略

**单元测试（vitest）** —— 纯函数，无需真环境：

- 标记块：无块→追加、有块→替换、重跑→字节不变
- JSON 合并：同事键保留、数组整体当值、键序稳定、序列化幂等
- herdr 文本合并：注释保留、冲突检测、`[keys]` 标量插在 `[[keys.command]]` 之前、`[theme].name` 行替换、顶层键插入
- diff 渲染：改动同事已有值时的输出格式

**fixture 三态** —— 模拟同事的三种基线：

1. **全空**（全新机器）
2. **已有但未自定义**（装了 Ghostty/herdr/pi，配置为默认值）
3. **重度自定义**（带注释、带同名键冲突、带自定义主题）

**集成测试** —— 不能真装 brew。用 **PATH 前置 stub 目录**注入假的 `brew` / `pi` / `herdr` / `npm`，测编排逻辑与错误分支：brew 失败、`herdr config check` 不通过触发回滚、pi 版本过低

**幂等测试** —— 三个 fixture 各连跑两次，断言第二次零字节变化

**手动验收** —— 先 `--dry-run` 看清单，再在干净机器上完整跑一遍

## 后续待办（实现完成后）

1. **本机自身的收尾**：改造后我自己的安装方式应从"软链指向仓库"切换为 `pi install /Users/jiezhou/Desktop/公司其他/pi-extension`（本地路径，pi 不复制文件，适合开发回路）
2. **清理本机混装状态**：`~/.pi/agent/extensions/` 现在同时有真文件（`commits.ts` / `checkpoint.ts` / `token-speed.ts` / `steer-or-interrupt.ts` / 两个 JSON）和指向仓库的软链（`auto-hide-thinking.ts` / `model-filter.ts` / `codex-usage` / `reload-all`），重复注册风险实际存在。用一次 `doctor` 诊断后按 `--adopt` 清理
3. **`startup-sync.ts` 的去留**：它已不在本机安装，但仍留在仓库里。若确认不再需要，下一次整理时一并移除

## 已知风险

| 风险 | 处理 |
|---|---|
| `~/Library/Application Support/com.mitchellh.ghostty/` 的跨目录优先级未验证（macOS 下 Ghostty 不认 `$HOME`，无法在沙箱里测） | 只检测不写；非空时在报告里提示 |
| pi 对 `pi.extensions` 里的**目录型条目**（`codex-usage` / `reload-all`）的加载语义未实测 | 实现时先写一个最小验证：确认 pi 不会递归加载这些目录里的 `parser.ts` 等辅助文件 |
| npm `postinstall` 执行环境的 PATH 不含 `/opt/homebrew/bin` | postinstall 不干重活（D9），brew 只由显式 CLI 调用 |
| 同事的 herdr 配置可能本就损坏 | Phase 4d 前置 `herdr config check`，坏了就停手 |
| 同事已有同名 herdr 插件 | 检测到就跳过并告知，不抢 |

## 验收标准

1. 在干净 Apple Silicon Mac 上，`npx -y 01-pi-workbench setup` 一条命令跑完，退出码 0
2. 跑完后：Ghostty 主题与 13 条 keybind 生效、herdr 快捷键与两个插件可用、pi 加载全部扩展与 `read-terminal` skill
3. 对同一台机器**连跑两次**，第二次零字节变化
4. `uninstall` 后所有 `~/.pi/agent/extensions/`、`~/.config/ghostty/`、`~/.config/herdr/` 回到 setup 前状态（减法语义下：我们加的键与块消失，同事的自定义完好）
5. 全程未修改 `models.json` / `auth.json` / `~/.cc-switch/`（用 mtime 断言）
