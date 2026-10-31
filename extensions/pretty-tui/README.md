# pretty-tui（本地定制版）

从 [`ykn0309/pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui) 的 **v0.2.9**（commit `57ea85a36a35003ba7fed90b611a4ddf8154205e`）拷来的源码，MIT，原作者 Kainan Yang，见 [LICENSE](LICENSE)。

放进本仓库是为了「换台机器 clone 下来、跑一次 `node scripts/link.mjs --fix` 就对齐」，不必再单独维护一份 checkout。

## 与上游 v0.2.9 的差异

1. **用户气泡底色**（`user-bubble-background.ts`、`rounded-bubbles.ts`）
   Herdr + Kitty 的 fullscreen 下，用户气泡用抗锯齿 PNG 底色代替蓝色字符边框：浅色 `#e8f3fe`，深色 `#303030`。PNG 用 `node:zlib` 生成，无新增依赖；图片以 `z=-1073741825` 压在文字下面，所以选中和搜索仍走原生。生成失败自动退回字符边框。
2. **统一边距**（`transcript-margins.ts`）
   对话区、待发送消息、状态区、上下两个 widget 区（含 Todos）、编辑器、footer 共用 12% 左右留白，约 76% 内容宽；窗口变窄时收缩，内容至少保留 60 列，再窄就取消。开关在 `~/.pi/agent/pretty-tui.json` 的 `transcriptMarginRatio`（0–0.30，0 = 关闭）。
3. **点击复制用户消息**（`index.ts`）
   fullscreen 下单击用户气泡正文或边框，复制该条原始文本（保留 Markdown、缩进、换行，不含边框）；链接和代码块的 `[Copy]` 优先，拖动框选不触发。

## 升级上游时

上游没有 merge 进本仓库的历史（本地只有一份 v0.2.9 快照），所以升级是手工的：取目标版本的 `extensions/` 覆盖过来，然后把上面三处改动重新打上，再在 pi 里 `/reload` 或用 `/restart` 确认气泡、边距、点击复制都没退化。旧的阶段性快照在原来的 checkout 里（`local-patches/`，未进本仓库）。

## 为什么不装 npm 包

`npm:pi-pretty-tui` 是上游原版，没有这三处改动。装了 npm 包再同时加载本目录会**重复加载**同一套原型补丁，所以 `~/.pi/agent/settings.json` 的 `packages` 里不要再留 pretty-tui 的 npm 条目或旧 checkout 路径。
