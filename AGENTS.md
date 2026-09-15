# AGENTS.md

给在本仓库里干活的 agent 的规矩。人看的说明在 [README.md](README.md)。

## 单一真源

`extensions/**` 与 `skills/**` 是本仓库的产物。**在开发机上，pi 加载的路径一律是软链**，指向本仓库里的文件 —— 改仓库即改 pi 正在跑的代码。

改完任何产物后跑一次，让漂移变成可见的事实（非 0 退出 = 有需要处理的项）：

```bash
node scripts/link.mjs          # 检查：软链正确 / 拷贝 / 漂移 / 缺失
node scripts/link.mjs --fix    # 把「拷贝一致 / 缺失」收敛成软链
```

`scripts/link.mjs` 里的 `ITEMS` 是**唯一权威清单**（同时写明哪些故意不装、哪些不属于本仓库）。新增扩展 / skill 时在那里加一行，别在别处再维护一份列表。

## 漂移要判方向

两边内容不同时不要默认「仓库新」：`pi-footer.json`、`pi-context-view.json` 会被扩展的界面改写，本地可能是新的（2026-09-15 实测过，两个方向都出现过）。先看 `--check` 打印的 diff，把较新的那份 `cp` 到另一边，再 `--fix`。

写盘方式：会被改写的仓库文件用 `writeFile` 覆盖写；一旦改成「写临时文件 + rename」的原子写，rename 会把软链替换成真实文件。

## 提交

- 只 `git add <本次改的文件>`：同一台机器常同时开着多个 pi 窗口写这个仓库，`git add -A` 会把别人未完成的改动一起提交。
- 改 `extensions/reload-all/` 后跑 `cd extensions/reload-all && npm test`。
- 设计文档先落 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`，再动代码。

## 发布与开发机的关系

发布走 pi 包（`pi install npm:@zionzionzion/pi-extensions`，见 README「安装」）；开发机上始终用软链跑本仓库的源码，两条路互不影响。`scripts/link.mjs` 只针对开发机的软链布局。
