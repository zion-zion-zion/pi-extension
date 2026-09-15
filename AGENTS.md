# AGENTS.md

给在本仓库里干活的 agent 的规矩。人看的说明在 [README.md](README.md)。

## 单一真源

`extensions/**` 与 `skills/**` 是本仓库的产物。**在开发机上，pi 加载的路径一律是软链**，指向本仓库里的文件 —— 改仓库即改 pi 正在跑的代码。

改完任何产物后跑一次，让漂移变成可见的事实（非 0 退出 = 有需要处理的项）：

```bash
node scripts/link.mjs          # 检查：软链正确 / 拷贝 / 漂移 / 缺失
node scripts/link.mjs --fix    # 把「拷贝一致 / 缺失」收敛成软链
```

`scripts/link.mjs` 里的 `ITEMS` 是**唯一权威清单**。新增扩展 / skill：在 `ITEMS` 加一行 → `node scripts/link.mjs --fix` 建软链 → 与代码一起提交；本机故意不装的写进 `NOT_INSTALLED` 并给出理由。清单之外的顶层产物会被脚本报成「未进清单」。

## 改完让窗口吃到新代码

仓库里改完，pi 里跑的还是旧模块，需要用户执行 `/reload`（快、不换进程）或 `/restart`（换进程，才能刷新 `models.json` / 环境变量 / pi 本体，以及原型、闭包、Symbol 里的脏状态）。把选哪条的理由讲清楚，别只说「reload 一下」—— 对照与选型见 [README](README.md)「说明」与 `docs/superpowers/specs/2026-09-14-restart-design.md`。

## 漂移要判方向

两边内容不同时不要默认「仓库新」：`pi-footer.json`、`pi-context-view.json` 会被扩展的界面改写，本地可能是新的（2026-09-15 实测过，两个方向都出现过）。先看 `--check` 打印的 diff，把较新的那份 `cp` 到另一边，再 `--fix`。

写盘方式：会被改写的仓库文件用 `writeFile` 覆盖写；一旦改成「写临时文件 + rename」的原子写，rename 会把软链替换成真实文件。

## 提交

- 只 `git add <本次改的文件>`：同一台机器常同时开着多个 pi 窗口写这个仓库，`git add -A` 会把别人未完成的改动一起提交。
- 改 `extensions/reload-all/` 后跑 `cd extensions/reload-all && npm test`。
- 设计文档先落 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`，再动代码。

## 发布与开发机的关系

发布走 pi 包（`pi install npm:@zionzionzion/pi-extensions`，见 README「安装」）；开发机上始终用软链跑本仓库的源码，两条路互不影响。`scripts/link.mjs` 只针对开发机的软链布局。
