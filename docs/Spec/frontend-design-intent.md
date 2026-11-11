# 前端设计意图抽取（`ui-reference.html` → 本项目实现）

> **性质**：本文件是**抽取记录**，不是规范。视觉语义的事实源仍是
> [`docs/facts/DESIGN.md`](../facts/DESIGN.md)；页面职责的事实源是
> [`docs/facts/pages-and-flows.md`](../facts/pages-and-flows.md)；任务范围的事实源是
> [`docs/Spec/SPEC-M1.md`](./SPEC-M1.md)。
>
> **原型地位**：`docs/facts/ui-reference.html` 是**视觉事实源**，不是代码事实源。
> 它的 HTML/CSS/JS **一行都不进实现** —— 只从中读「布局比例、信息层级、交互模式」，
> 再用本项目的 Token 与 shadcn/ui 组件重建。
>
> 抽取人：开发侧；抽取日期：2026-11-10。

---

## 0. 先说三条会让实现跑偏的事实

原型是**一个自包含的单页 demo**，它和本仓库有三处结构性落差，抽取时必须逐条映射，
否则照着抄会同时违反工程规则与 SPEC。

| # | 原型的做法 | 本项目的做法 | 依据 |
|---|---|---|---|
| 0-1 | `<script src="https://cdn.tailwindcss.com/3.4.17">`（第 7 行）、`<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1">`（第 8 行） | **两行都不得进入实现**。Tailwind 走仓库既有构建链；图表库必须是 `package.json` 里已声明的本地 npm 包 | `工程规则.md` §9「构建期不联网」、`tests/offline.spec.ts` 会直接扫红 |
| 0-2 | `tailwind.config` 内联在页面里，`theme.extend.colors` 用 `var(--bg-canvas)` 等自定义名，并夹带裸 hex（`brand: '#2563EB'`、`'eval-pass': '#059669'`，第 22–31 行） | 本仓库是 **Tailwind v3.4 + `tailwind.config.ts` + `hsl(var(--…))`**，Token 名是 `background` / `card` / `muted` / `eval-pass-fg` 等，与原型**不是同一套名字** | `DESIGN.md` §2.1 / §2.8；需求方 2026-11-07 已拍板「Tailwind v3.4，稳定优先」 |
| 0-3 | `:root` 里 `--bg-canvas:#F8FAFC` … `html.dark` 里 `#090D16 / #111827 / #1F2937`（第 42–75 行） | **深色值不得照抄**。`DESIGN.md` §2.4 的深色值是**单独选定并验证过对比度**的另一组（`#0F172A / #1E293B / #334155`）。抄原型的深色等于绕过 §2.5 的实测记录 | `DESIGN.md` §2.1 第 3 条 |

另外两处**尺寸**落差（已在 §1 表格里逐条标注）：原型侧栏是 `w-56`（224px），
`DESIGN.md` §1.2 定 **220px**；原型抽屉注释写 720px、类名写 `max-w-[740px]`，
`DESIGN.md` §1.2 给的是 **680–760px 区间**、现有 `Sheet` 实现是 720/760 两档。

---

## 1. 设计意图抽取表

> 「映射到 DESIGN.md 的 token / 组件」一列给的是**实现时该写的 Tailwind 类名或组件名**，
> 不是原型里的类名。原型类名 → 本项目类名的完整对照见 §3。

| # | 原型区块（行号） | 布局与尺寸 | 信息层级 | 交互模式 | 映射到 DESIGN.md 的 token / 组件 |
|---|---|---|---|---|---|
| **1** | **顶部状态栏** `header`（124–172） | 高 **48px**（`h-12`），左右内边距 12→16px，底边 1px 分隔线，`z-20` 吸顶 | 三级：① 折叠按钮 + EM 徽标 24×24 + 产品名 + `v2.4` 徽章 → ② `/` 分隔 + 「评测目标」下拉 → ③ 右对齐操作区（SSE 实时胶囊、`发起新评测` 主按钮、`交接给 Claude Code` 次按钮、主题切换） | 折叠按钮切换侧栏宽度；下拉切换全局项目过滤会重渲染其下全部视图；SSE 胶囊**仅在跑批中可见**，带 8px 呼吸点；主题切换翻转 `.dark` | `bg-card` + `border-b border-border` + `h-topbar`(48px)。按钮 `components/ui/button.tsx`（primary / outline / ghost）；徽标 `bg-primary text-primary-foreground`；下拉见 §4.1（**用已存在的原生 `Select`，`components/ui/input.tsx:46`**）；SSE 胶囊用 `bg-eval-running-bg` + `text-eval-running` + `animate-eval-pulse`（`DESIGN.md` §4.2）；主题切换已有 `components/shell/theme-toggle.tsx` |
| **2** | **侧边导航 220px** `aside#app-sidebar`（178–254） | 展开 **220px**（原型 `w-56`=224px，**按 DESIGN 取 220px**）/ 折叠 **56px**；宽度变化 200ms；右 1px 分隔线；上滚动区 + 下固定底块 | 两个分组标题（`核心评测工作台 (P0)` / `基础设施与门禁 (Admin)`）→ 5 个导航项，每项 = 16px 图标 + 12px 文字 + 右端计数徽章 → 分组下方一张「三级准出判定门禁」图例卡（L1 100% / L2 ≥0.85 / L3 0 新增退化）→ 底部一个抽屉触发按钮（红点 + `J/K` kbd 提示） | 点击切换视图（不换页）；当前项高亮；折叠态只剩图标 + `title` tooltip；底块按钮直接打开 P3 抽屉 | **不照抄**：现有 `components/shell/sidebar.tsx` 已实现 220/56px + `nav.ts` 的 4 分区。原型有 2 组 5 项 + 图例卡 + 抽屉入口，与 `DESIGN.md` §1.3 第 4 条（**只有 4 个分区**）与 `SPEC-M1` §1.3（M1 只渲染「运行」「资产」）冲突，见 §5-C3。分组标题**禁止**用原型的大写等宽 eyebrow，按 `DESIGN.md` §1.1 用 sentence case + `text-muted-foreground` |
| **3** | **P1 实验与跑批概览** `#view-runs`（262–362） | 内容区左右 24px 内边距；4 张 KPI 卡 `grid-cols-2 lg:grid-cols-4 gap-3`（每张 `p-3.5`）；工具条 1 行；表格：表头 32px、行高 36px、10 列、横向可滚 | KPI 卡 = 标题(12px `text-muted-foreground`) + 右上角状态胶囊 + 24px 主数字(等宽粗体) + 右侧对比值 + 11px 说明。表格列序：`对比勾选 ｜ Run ID/项目 ｜ 评测集版本 ｜ 待测目标/模型路由 ｜ 核心主指标(Δ) ｜ L1 红线保真 ｜ P95 延迟 ｜ 总成本 ｜ 准出门禁 ｜ 操作`；数字列一律右对齐 + `tabular-nums` | 搜索框 `oninput` 实时过滤；三档分段过滤（全部/PASS/BLOCK）；行首 checkbox 做 AB 对比勾选（已选 N 笔）；整行可点进 P2；行尾「诊断明细」按钮 | `Card` + `CardHeader`/`CardContent`（`components/ui/card.tsx`）；表格用 `DataTable`（TanStack Table，真 `<table>`/`<th scope>`）；数字列 `numeric: true` ⇒ 自动右对齐 + `.num`；Δ 徽章用 `Badge variant="pass"/"fail"` 或 `MetricDeltaBadge`（`DESIGN.md` §4.1）；准出门禁列用 `Badge`；空/骨架/refetch 三态由 `DataTable` 统一承担（`AS-3`）。**注意**：KPI 卡与「准出门禁」列在 M1 无接口支撑，见 §5-C6 |
| **4** | **P2 双版本 AB 对比 + 三级门禁横幅** `#view-compare`（367–457） | 选择器条 1 行；门禁横幅通栏 `p-3.5`，左 32×32 裁决块 + 标题 + 内联指标胶囊；两图 `grid-cols-1 lg:grid-cols-2 gap-4`，每图卡片 `p-4` + 画布 `h-60`（240px）；逐条表 8 列 | ① 基线/候选两个下拉 + 两个「示例场景」快捷按钮 → ② **三级门禁裁决横幅**（PASS 绿底 / BLOCK 红底，含 L1/L2/L3 三段结论，右侧一个「看 Diff 样本」按钮）→ ③ 左右双图（多维算子分项柱图 + 延迟/得分折线）→ ④ 逐条诊断表（Case ID/场景、Query 摘要、基线分、当前分(Δ)、红线、延迟变化、归因标签、操作） | 下拉换对即重渲染横幅与图；横幅内按钮**直接开 P3 抽屉**并定位到指定 case；表格上方三档过滤胶囊（全部 8 / 退化 2 / 提升 4）；点任意行开抽屉；分差图点击退化点也开抽屉 | `Card` + 图容器 `h-60`；`Badge variant="pass"/"fail"`（横幅外层用 `bg-eval-pass-bg`/`bg-eval-fail-bg` + `border-eval-pass-mark/40`）；过滤胶囊 = `Button variant="ghost"` + 选中态 `bg-foreground text-background`；图表见 §4.2（**库待裁定**）。**M1 无此路由、无对比接口**，见 §5-C2 |
| **5** | **P3 Badcase Diff 抽屉**（602–712） | 遮罩 `bg-black/35`；面板 `fixed top-12 bottom-0 right-0 w-full max-w-[740px]`；三段固定/滚动结构：**固定头**（约 52px）+ **滚动体**（`flex-1 overflow-y-auto p-4 space-y-4`）+ **固定脚**（约 52px）；宽度 `<640px` 全屏 | 头部：状态徽章 + `CASE-xxx`(等宽粗体) + 分类 + `↑Prev[K]`/`↓Next[J]`/关闭。体：① 输入问题 / 黄金答案两栏 → ② Split/Unified 切换 + 双栏高亮 Diff（左基线右候选，各带延迟）→ ③ 算子打分明细 4 列网格 → ④ RAG 命中切片列表 → ⑤ 裁判思维链评语（琥珀色块）。脚：根因归类下拉 + 「回流至黄金必过集」主按钮 | 头部按钮与 **J/K** 键切换上/下一条（循环）；**Esc** 关闭；遮罩点击关闭；Split/Unified 切换重渲染中段；键盘在 `INPUT/TEXTAREA/SELECT` 聚焦时**不拦截 J/K** | `components/ui/sheet.tsx`（Radix Dialog：自带 focus trap / Esc / 焦点归还）；**宽度取 740px**（`SheetContent width` 需扩一档，或改 `max-w-[740px]`）；Diff 行用 `bg-diff-del-bg`/`text-diff-del-fg` 与 `bg-diff-add-bg`/`text-diff-add-fg`，**必须带 `−`/`+` 前缀**（`DESIGN.md` §4.3）；打分明细用 `grid-cols-2 sm:grid-cols-4`；RAG/裁判评语按 `DESIGN.md` §4.3 用 `Accordion`（默认收起）。**J/K 当前完全未实现**，见 §4.3 |
| **6** | **P4 评测集与不可变版本** `#view-datasets`（462–478，卡片模板 1708–1723） | 顶部说明卡通栏（左标题+说明，右「导入 JSONL」主按钮）；卡片网格 `grid-cols-1 md:grid-cols-2 gap-4`，每卡 `p-4`，上下两段（内容区 + `border-t` 页脚） | 卡内：等宽粗体集名 + 右上 `N Cases` 徽章 → 项目名（品牌色 12px）→ 说明（12px `text-body`）→ 页脚：SHA-256 截断哈希 + 「以此发起评测 →」链接 | 「导入 JSONL」开模态；页脚链接跳发起评测；卡片本身不可点 | `Card` + `CardHeader`/`CardContent`；徽章 `Badge variant="muted"`。**与 `SPEC-M1` `[FE-02]` 冲突**：SPEC 要的是 6 列**表格** + 上传面板 + 内联版本历史，不是卡片网格。且 `DESIGN.md` §1.3 第 1 条要求「筛选器只有一行、置于表格上方」。见 §5-C4 |
| **7** | **P5 评测算子库 + 在线沙箱** `#view-evaluators`（483–549） | 外层 `lg:grid-cols-12`：左 **7/12** 算子目录（上下两张卡：确定性规则算子 / LLM-as-Judge），右 **5/12** 沙箱卡（`h-fit`）；行内列表项 `py-2.5` + 分隔线 | 左：每项 = 等宽算子名 + 能力标签 + 说明 + 右端成本/状态。右：算子下拉 → 期望值 `textarea(2行)` → 实际输出 `textarea(3行)` → 全宽「执行断言」主按钮 → 结果框（等宽，等宽区） | 算子下拉切换时自动装载该算子的示例值并立即跑一次；点按钮重算；结果框实时显示 PASS/FAIL 与细节 | `Card`；下拉/文本域见 §4.1；结果框 `bg-muted` + `font-mono`。**M1 无此路由**：`evaluators` 表为 ❌ 空表，`PG-07` 属 M4；沙箱需要算子实现接口（`evaluators` 契约有 `EvaluatorOperator`，但无 HTTP 端点）。见 §5-C2 |
| **8** | **P6 模型网关 + CI 门禁** `#view-gateway`（554–597） | 两列 `grid-cols-1 lg:grid-cols-2 gap-4`，等高卡片 `p-4 space-y-3` | 左卡：标题+说明 + 右上「一键连通性探测」→ 厂商列表（分隔线）。右卡：标题+说明 + `Webhook 就绪` 徽章 → 深色代码块（等宽、`overflow-x-auto`、可全选）→ 底部一行：说明文字 + 「复制接入命令」主按钮 | 探测按钮逐厂商发请求；代码块整体可选中复制；复制走 `copyTextWithToast` | `Card`；代码块 `bg-muted font-mono text-2xs`；复制按钮 `Button`；Toast 见 §4.1。**M1 无此路由**：`PG-09` 属 M2，探测接口 `POST /api/providers/{id}/probe` 契约尚未存在（`milestones.md` §3 已登记）。见 §5-C2 |

---

## 2. 三个待回答问题

### 2.1 （a）哪些 hex 能直接映射到现有 Token，哪些需要新增

**结论先说：13 行对照表里 11 行能直接落地，2 行在本项目里"名字对不上或语义已升级"；
另有 6 处原型的颜色在本项目里根本没有 Token，必须逐条裁定。**

#### 2.1.1 原型 hex → 本项目 Token（全量，按原型 `:root` 顺序）

| 原型 hex | 原型变量 | 本项目 Token | Tailwind 类 | 结论 |
|---|---|---|---|---|
| `#F8FAFC` | `--bg-canvas` | `--background` | `bg-background` | ✅ 已有 |
| `#FFFFFF` | `--bg-surface` | `--card` | `bg-card` | ✅ 已有 |
| `#F1F5F9` | `--bg-muted` | `--muted` | `bg-muted` | ✅ 已有 |
| `#E2E8F0` | `--border-color` | `--border` / `--input` | `border-border` | ✅ 已有 |
| `#0F172A` | `--text-primary` | `--foreground` | `text-foreground` | ✅ 已有 |
| `#334155` | `--text-secondary` | `--body-foreground` | **`text-body`** | ⚠️ **名字不同**。`tailwind.config.ts` 里的 `secondary` 已被 shadcn 占用 = `hsl(var(--muted))`（**背景色**），拿它当文字色会渲染成浅灰块。正确类是 `text-body` |
| `#64748B` | `--text-muted` | `--muted-foreground` | `text-muted-foreground` | ✅ 已有 |
| `#2563EB` | `brand` | `--primary` / `--ring` | `bg-primary` / `text-primary` / `ring-ring` | ✅ 已有 |
| `#1D4ED8` | `brand-hover` | **无独立 Token** | 建议 `hover:bg-primary/90` | 🟡 **不新增 Token**：悬停态用透明度即可，为此多一个 Token 不划算 |
| `#059669` | `eval-pass` | `--eval-pass-mark`（`#059669`）；文字用 `--eval-pass-fg`（`#047857`） | 描边/图标/填充 `bg-eval-pass-mark`；**文字 `text-eval-pass`** | ⚠️ **语义已升级**。`DESIGN.md` §2.3 因实测对比度 3.58 不达 AA，**刻意**把 `#059669` 降级为 `mark`，把文字改用 `#047857`。原型把它当文字与按钮底色用，照抄会直接违反 §2.5 的实测结论 |
| `#ECFDF5` | `--eval-pass-bg` | `--eval-pass-bg` | `bg-eval-pass-bg` | ✅ 已有（同值） |
| `#DC2626` | `eval-fail` | `--eval-fail-mark`；文字 `--eval-fail-fg`（`#B91C1C`） | 同上三档结构 | ⚠️ 同 `#059669`：文字用 `text-eval-fail`，描边/填充用 `bg-eval-fail-mark` |
| `#FEF2F2` | `--eval-fail-bg` | `--eval-fail-bg` | `bg-eval-fail-bg` | ✅ 已有（同值） |
| `#D97706` | `eval-warn` | `--eval-warn-mark`；文字 `--eval-warn-fg`（`#B45309`） | 同上三档结构 | ⚠️ 同上 |
| `#FFFBEB` | `--eval-warn-bg` | `--eval-warn-bg` | `bg-eval-warn-bg` | ✅ 已有（同值） |
| `#0284C7` | `eval-run` | `--eval-running-mark`；文字 `--eval-running-fg`（`#0369A1`） | 同上三档结构 | ⚠️ 同上，且**Token 名不同**：本项目叫 `eval-running`，不是 `eval-run` |
| `#F0F9FF` | `--eval-run-bg` | `--eval-running-bg`（本项目为 `#E0F2FE`） | `bg-eval-running-bg` | 🟡 **值不同**（sky-50 vs sky-100）。**采用本项目值**，不新增 Token |
| `#FFE4E6` | `--diff-del-bg` | `--diff-del-bg` | `bg-diff-del-bg`（`tailwind.config.ts` 键名是 `diff.del.bg` ⇒ 写作 `bg-diff-del-bg`） | ✅ 已有（同值） |
| `#9F1239` | `--diff-del-text` | `--diff-del-fg` | `text-diff-del-fg` | ✅ 已有（同值，名字不同） |
| `#DCFCE7` | `--diff-add-bg` | `--diff-add-bg` | `bg-diff-add-bg` | ✅ 已有（同值） |
| `#166534` | `--diff-add-text` | `--diff-add-fg` | `text-diff-add-fg` | ✅ 已有（同值，名字不同） |
| `#475569` | 图表刻度文字（浅色，1507 行）；正文 11px 时间戳 | **没有文字层 Token**。`#475569` 只作为 `--chart-axis` 的**深色**值存在（`DESIGN.md` §2.6），不是浅色文字色 | 候选 `text-body`(=`#334155`) 或 `text-muted-foreground`(=`#64748B`) | 🔴 **需裁定**。`DESIGN.md` §2.5 明确写「`#475569` on `#F8FAFC` = 7.24 ✅（**11px 时间戳必须用它**）」，但 §2.2 的 Token 表里**没有任何 Token 的浅色值是 `#475569`**。这是 DESIGN 自身的缺口：要么补一个浅色 Token（如 `--foreground-subtle: 215 25% 33%`），要么把 11px 时间戳改判给 `text-muted-foreground` —— 但那是 4.53，§2.5 自己标注「**仅限 ≥12px**」，11px 不达标。**我不自行补 Token**，等裁定 |
| `#94A3B8`（深色刻度） | — | `--muted-foreground` 深色值 | `text-muted-foreground` | ✅ 已有（深色值恰好相同） |

**原型的深色值（`#090D16` / `#111827` / `#1F2937` / `#CBD5E1`）一律不采纳** ——
`DESIGN.md` §2.4 是另一组单独选定并验证过的值。这条不讨论。

#### 2.1.1b 简报里那 13 行 Token 名 → 本仓库实际存在的类名

简报给的对照表用的是 `text-success` / `bg-success` 这类**通用语义名**。本仓库
`tailwind.config.ts` 里**不存在** `success` / `warning` / `info` 三个键，
对应的能力由 `eval.*` 三档结构承担。逐条换算（全部已验证键名存在）：

| 简报写的 | 本仓库实际可用的 | 说明 |
|---|---|---|
| `bg-background` | `bg-background` | ✅ 一致 |
| `bg-card` | `bg-card` | ✅ 一致 |
| `bg-muted` | `bg-muted` | ✅ 一致 |
| `border-border` | `border-border` | ✅ 一致 |
| `text-foreground` | `text-foreground` | ✅ 一致 |
| `text-secondary` | **`text-body`** | 🔴 简报的 `text-secondary` 在本仓库指向**背景色**（`--muted`），误用会渲染成浅灰块。文字用 `text-body`（`#334155`） |
| `text-muted-foreground` | `text-muted-foreground` | ✅ 一致 |
| `text-primary` / `bg-primary` | `text-primary` / `bg-primary` | ✅ 一致 |
| `text-success` / `bg-success` | `text-eval-pass` / `bg-eval-pass-mark` / `bg-eval-pass-bg` | 🔴 键不存在。文字 `text-eval-pass`、实底/描边 `bg-eval-pass-mark`、胶囊底 `bg-eval-pass-bg`（`DESIGN.md` §2.3 三档） |
| `text-destructive` / `bg-destructive` | `text-eval-fail` / `bg-eval-fail-mark` | 🟡 `destructive` 键**存在**（`tailwind.config.ts:37`，DEFAULT = `--eval-fail-fg`），但本仓库一律用 `eval-fail`，避免两套名字各写一半 |
| `text-warning` / `bg-warning` | `text-eval-warn` / `bg-eval-warn-mark` | 🔴 键不存在 |
| `text-info` / `bg-info` | `text-eval-running` / `bg-eval-running-mark` | 🔴 键不存在。「信息/运行中」在本仓库是 `eval-running` |
| `bg-diff-del` / `bg-diff-add` | `bg-diff-del-bg` / `bg-diff-add-bg` | 🟡 键是嵌套的 `diff.del.bg` ⇒ 必须写全 `bg-diff-del-bg`；文字用 `text-diff-del-fg` |

**结论**：13 行里 **7 行照抄即可**，**1 行必须改名**（`text-secondary` → `text-body`），
**4 行要用 `eval-*` 三档替代简报的通用名**，**1 行要补 `-bg`/`-fg` 后缀**。
本仓库**不需要**为了这 13 行进 `DESIGN.md` 加任何新 Token —— 除 §2.1.1 末行的 `#475569` 缺口外。

#### 2.1.2 原型用了、但本项目没有对应 Token 的颜色（必须逐条裁定）

这些不是 hex 常量，而是**混在 Tailwind 类名里的原生调色板**，`AS-2` 拦不住（不是裸 hex 字面量），
但 `check:tokens` 的落地会经不起审查 —— 它们同样是「未走语义 Token」：

| # | 原型写法（行号） | 语义 | 建议处置 |
|---|---|---|---|
| N-1 | `border-emerald-500/30`（382、1397）、`border-red-500/30`（385、1418）、`border-amber-500/30`（687） | 状态色描边 | 改用本项目已有的 mark 档：`border-eval-pass-mark/30` / `border-eval-fail-mark/30` / `border-eval-warn-mark/30`。**不新增 Token** |
| N-2 | `border border-sky-500/30`（151） | SSE 运行中胶囊描边 | `border-eval-running-mark/30` |
| N-3 | `bg-brand/10`（371、515） | 品牌浅底 | `bg-primary/10` |
| N-4 | `bg-black/35`（604，抽屉遮罩）、`bg-black/45`（719、776、802，模态遮罩） | 模态遮罩 | 现有 `Sheet` 用 `bg-foreground/20`。**建议沿用 `bg-foreground/20`**，不为遮罩新增 Token；如需更深，改 `bg-foreground/40` |
| N-5 | `bg-eval-pass` / `bg-eval-fail` 作**实底按钮**+ 白字（1393、1406、1414、1425） | 裁决块与 CTA | 白字压 `#059669` 只有 3.58:1，**不达 AA**。改用 `text-eval-pass`（= `#047857`，白字 5.21:1 ✅）或 `bg-primary` |
| N-6 | `shadow-2xs` / `shadow-sm` / `shadow-2xl`（多处） | 阴影 | `DESIGN.md` §1.1：**默认无阴影**，只有 Overlay 层允许 `shadow-overlay`。卡片一律去掉阴影，用 1px 边框 |

> **这是一条硬结论**：原型的视觉层级有相当一部分靠阴影与原生调色板撑，本项目的
> `DESIGN.md` 明确禁止这两样。照抄会同时违反 §1.1 与 §7.1。**抽取表里所有卡片都不带阴影。**

### 2.2 （b）图表库选型

> **→ 2026-11-10 裁定：选 A（`echarts`）。** 需求方明确授权 `npm install echarts`，
> 装完在 `package.json` 记录版本。**已执行：`echarts@^5.6.0` 已写入 `dependencies`。**
> 下文保留裁定前的现场记录，供回溯。
>
> ⚠️ **但「装了库」≠「第 3 批解禁」。** 第 3 批做的是 **P2 双版本 AB 对比**，而 P2 在 M1
> **无路由、无 `/api/runs/compare`、`baselines` / `regression_gates` / `gate_evaluations` 三张表全空**
> （见下方 C2）。需求方同一条消息里又拍定了「方案 A：只实现 P1 / P4 / P3，P2 / P5 / P6 留占位路由」。
> 两条裁定在**批次范围**上冲突，本文按**方案 A** 执行 —— 图表库装好备用，第 3 批仍然不出图。
> 若后续扩范围，另开一轮。

**结论（裁定前）：`package.json` 里没有任何图表库，本项 待裁定。我没有执行 `npm install`。**

已核实的事实：

- `src/package.json` 的 `dependencies` 与 `devDependencies` 全部内容里 **没有**
  `echarts`、`chart.js`、`recharts`、`d3` 中的任何一个（`@radix-ui/*`、
  `@tanstack/react-table`、`lucide-react` 等都与图表无关）。
- `lib/charts/` 目录**不存在**。
- 原型用的 `chart.js@4.4.1` 是**从 jsdelivr CDN 引入的**（第 8 行），按规则不得沿用。

已有文档其实已经指过一次方向，供裁定参考（**这不是我替你做决定**）：

- `docs/工程规则.md` §4.1 原文：「**ECharts 主题必须从 Token 生成一次（`lib/charts/theme.ts`），禁止在 `option` 里写裸 `#hex`**」。
- `docs/facts/DESIGN.md` §5.2 第 10 条原文与上面同一句。
- `docs/工程规则.md` §10 变更记录（2026-11-07）：「不引任何 CDN 版图标 / 图表 / 字体资源，一律走 npm 本地包（Lucide / **ECharts**）」。

也就是说，**三处独立文档都已按 ECharts 写下了主题约定与落地路径**（含文件路径
`lib/charts/theme.ts`）。若选别的库，那三句约定需要同步改口径 —— 这属于改规范，不在我职权内。

候选与取舍（等你裁）：

| 选项 | 优点 | 代价 | 与既有文档的一致性 |
|---|---|---|---|
| **A. `echarts`（推荐）** | 三处文档已按它写死主题约定与 `lib/charts/theme.ts` 路径；柱/折线/雷达/发散条都原生支持；`DESIGN.md` §5.1 要的四种图全覆盖 | 需新增 1 个 dependency；包体较大（可按需引入 `echarts/core` 减重）；Canvas 渲染，需自己保证键盘可访问（`DESIGN.md` §5.2 第 8 条要求焦点与 hover 同信息） | ✅ 三处文档零改动 |
| B. 纯 SVG 手写（零依赖） | 不新增依赖；SVG 天生可 `role="img"` + `<title>`，无障碍最好做 | 柱/折线/雷达/发散条全部要自己算坐标轴、刻度、布局；`DESIGN.md` §5 的 10 条红线要逐条手写实现，工作量显著大于页面其它部分 | ⚠️ 与「ECharts 主题从 Token 生成」三处约定冲突，需改文档 |
| C. `recharts` | React 组件式，代码短 | 仍需新增依赖；`recharts` 默认颜色与阴影风格与 `DESIGN.md` §1.1「无阴影、少色」的基调相冲，改造成本在主题层 | ⚠️ 同 B |

**在你裁定前，第 2 批与第 3 批的图表部分无法开工**（第 3 批 P2 双子图直接依赖它）。

### 2.3 （c）P3 抽屉的 J/K / Esc / 焦点归还是否已有 Playwright 断言

**结论：Esc 关闭 + 焦点归还 有断言（在一个手写 Playwright 脚本里）；J/K 完全没有 —— 既没有断言，也没有实现。**

| 能力 | 实现 | 断言 | 证据 |
|---|---|---|---|
| `Esc` 关闭 | ✅ 有（Radix Dialog 提供，`components/ui/sheet.tsx` 基于 `@radix-ui/react-dialog`） | ✅ 有 | `scripts/pg-interaction-check.ts:190` `page.keyboard.press('Escape')`，`:192` 断言抽屉隐藏 |
| 关闭后焦点归还触发元素 | ✅ 有（受控抽屉 + 显式 `onCloseAutoFocus` 接管） | ✅ 有 | `app/runs/[runId]/page.tsx:337` `onCloseAutoFocus`；断言在 `scripts/pg-interaction-check.ts:193-197`；结构断言在 `tests/run-detail-ui-render.spec.ts:182-187` |
| 打开后焦点进入抽屉 | ✅ Radix 提供 | ✅ 有 | `scripts/pg-interaction-check.ts:181-187` |
| **`J` 下一条 / `K` 上一条** | ❌ **完全没有** | ❌ **没有** | `grep -rn "keydown" app components lib` → **零命中**；`tests/*.spec.ts` 里 `grep "Escape\|keydown\|KeyJ"` → **零命中**。`DESIGN.md` §4.3 与 §6.3 都要求 J/K，但从未落地 |

补充三条实现约束（来自 `DESIGN.md`，实现时必须遵守，断言也要覆盖）：

1. **监听挂在 Sheet 容器上**，不是 `window`（§4.3「监听挂在 **Sheet 容器**上」）。原型挂在
   `window` 上（1977 行），照抄会让 J/K 在抽屉关闭时仍然生效。
2. **作用域排除**：`document.activeElement` 落在 `input` / `textarea` / `[contenteditable]` /
   `select` 内时**一律不拦截**（§4.3 的 ⚠️ 条目）。原型写了 `INPUT/TEXTAREA/SELECT`，
   **漏了 `[contenteditable]`** —— 按 DESIGN 补上。
3. **`Esc` 优先级最高**（§4.3）：在输入框里按 Esc 也要能关（Radix 默认行为即如此，不要自己抢）。

**按简报要求，第 4 批必须先写断言、确认 RED（J/K 现在必然失败），再实现。**

---

## 3. 原型类名 → 本项目类名对照（照抄会写错的那些）

原型的配色命名是一套**自成体系的自定义名**，与 `tailwind.config.ts` 不同名。逐条对照：

| 原型类名 | 本项目等价写法 | 说明 |
|---|---|---|
| `bg-surface` | `bg-card` | 卡片/表格主表面 |
| `bg-canvas` | `bg-background` | 主画布 |
| `bg-muted` | `bg-muted` | ✅ 同名同义 |
| `border-borderline` | `border-border` | |
| `text-ink` | `text-foreground` | 主标题 / 核心指标 |
| `text-inksub` | `text-body` | 正文（**不是** `text-secondary`） |
| `text-inkmute` | `text-muted-foreground` | 次要元数据 / 时间戳 |
| `bg-brand` / `text-brand` | `bg-primary` / `text-primary` | |
| `bg-brand-hover` | `hover:bg-primary/90` | 无独立 Token |
| `text-eval-pass`（文字） | `text-eval-pass` | ✅ 同名，但值不同：本项目是 `#047857`（原型 `#059669`） |
| `bg-eval-pass`（实底） | `bg-eval-pass-mark` | 实底/描边/图标用 mark 档 |
| `bg-eval-pass-bg` | `bg-eval-pass-bg` | ✅ 同名同值 |
| `text-eval-fail` / `bg-eval-fail` / `bg-eval-fail-bg` | `text-eval-fail` / `bg-eval-fail-mark` / `bg-eval-fail-bg` | 同上 |
| `text-eval-warn` / `bg-eval-warn` / `bg-eval-warn-bg` | `text-eval-warn` / `bg-eval-warn-mark` / `bg-eval-warn-bg` | 同上 |
| `bg-eval-run` / `bg-eval-run-bg` | `bg-eval-running-mark` / `bg-eval-running-bg` | **Token 名不同**（`run` → `running`） |
| `text-eval-run` | `text-eval-running` | |
| `shadow-2xs` / `shadow-sm` / `shadow-2xl`（卡片） | **删除** | `DESIGN.md` §1.1 默认无阴影 |
| `shadow-2xl`（抽屉） | `shadow-overlay` | Overlay 层唯一允许的阴影 |
| `text-[11px]` | `text-2xs`（=11px/16px） | 有 Token 就别写任意值 |
| `text-[10px]` | **无对应 Token** | 低于 `DESIGN.md` §3.1 最小字号，建议并入 `text-2xs` |
| `py-0.2`（188、196、204 等） | **非法类** | 原型里这是笔误（Tailwind 无 `0.2` 间距档），照抄会静默失效 |
| `tabular-nums` | `.num`（含 `slashed-zero`）或 `num-mono` | `DESIGN.md` §3.2 强制 `.num`，光写 `tabular-nums` 少了 `slashed-zero` |
| `select-none`（body，121 行） | **不加** | 全站禁选会让用户复制不了文本，与 `AS-3` 的「一键复制」相冲 |
| 大写等宽分组标题（181、218） | sentence case + `font-medium` + `text-muted-foreground` | `DESIGN.md` §1.1 明令禁止 ALL-CAPS eyebrow |

---

## 4. 交互与状态迁移清单（不搬 `innerHTML`）

原型的状态与函数都在页面底部的 `<script>` 里。**只迁行为，不迁实现。**

| 原型（行号） | 本项目落点 | 说明 |
|---|---|---|
| `const state = {…}`（836–845） | 组件内 `useState` / 派生 | M1 不引入 Zustand：跨页共享的只有主题（已由 `theme-toggle` 处理）。`app-shell.tsx` 的注释已按同一理由拍板过「一个布尔值不值得建 store」 |
| `switchView(viewName)`（1198） | **不迁** | 本项目是 App Router 多路由（`/runs`、`/datasets`…），视图切换 = 导航，不是 class 切换 |
| `renderRunsTable()`（约 1280） | **不迁** | React `map` + `DataTable` |
| `renderComparisonView()`（1376） | **不迁** | React `map` |
| `renderDatasetsView()`（1705） | **不迁** | React `map` |
| `renderEvaluatorsView()`（1751） | **不迁** | React `map` |
| `openDiffDrawer(caseId)`（1599） | 组件 handler + `useState<string \| null>` | 现有 `app/runs/[runId]/page.tsx:69` 的 `openCaseKey` 即此 |
| `navigateDrawerCase(dir)`（1687） | 组件 handler（`J`/`K` 与其共用） | 循环取模逻辑可保留 |
| `closeDiffDrawer()`（1693） | `setOpenCaseKey(null)` | 现有实现已如此 |
| `setCaseDiffFilter(filter)`（1435） | `useState` + 过滤派生 | — |
| `setRunGateFilter(gate)`（1252） | `useState` + 过滤派生 | — |
| `setDiffMode(mode)`（1675） | `useState<'SPLIT' \| 'UNIFIED'>` | 对应 `DESIGN.md` §4.3 的 Tabs |
| `toggleRunCheckbox(runId)`（1265） | `useState<string[]>` | — |
| `showToast(msg)`（1965） | **工具函数**，不挂 `window` | 见 §4.1 |
| `copyTextWithToast(text, msg)`（1942） | **工具函数**，不挂 `window` | 同上 |
| `window.addEventListener('keydown', …)`（1977） | `useEffect` + 挂 Sheet 容器 + 关闭时解绑 | 见 §2.3 |
| `window.onload = () => switchView('runs')`（1991） | **不迁** | 路由即入口 |

### 4.1 四个缺失的 shadcn/ui 基础件

| 组件 | 状态 | 代价 | 说明 |
|---|---|---|---|
| `Card` / `CardHeader` / `CardContent` | ✅ 已有（`components/ui/card.tsx`） | — | — |
| `Table` 家族 | ✅ 已有（`components/ui/table.tsx` + `data-table.tsx`） | — | TanStack Table，真 `<table>` |
| `Sheet` | ✅ 已有（`components/ui/sheet.tsx`） | 需扩一档宽度到 740px | 基于已安装的 `@radix-ui/react-dialog` |
| `Badge` | ✅ 已有 | — | 有 `pass/fail/warn/running/muted` 五档 |
| `Button` | ✅ 已有 | — | — |
| **`Select`（原生）** | ✅ **已存在** | — | 🔴 **更正（2026-11-10 复核）**：本文件初稿写「`Select` ❌ 缺」，**是错的**。`components/ui/input.tsx:46-60` 已导出原生 `<select>` 包装（`Select`）；`Textarea`（`:28-44`）与 `Label`（`:63-72`）也在同一文件里。`app/datasets/page.tsx`、`app/runs/new/page.tsx`、`app/targets/page.tsx` 都已在用 |
| **`Dialog`（模态）** | ⚠️ **无独立 `dialog.tsx` 文件**，但 Radix 原语已就位 | 🟢 本地新增源码，非新依赖 | `@radix-ui/react-dialog` 已安装（`components/ui/sheet.tsx` 就在用 `DialogPrimitive`）。若第 5 批真的需要居中模态，照 shadcn 模板补一个 `dialog.tsx` 即可 |
| **`Toast`** | ❌ 缺 | 见下方裁定 | 全仓库 `grep -rn "sonner\|toast"` **零命中**，`package.json` 无 `sonner`、无任何 toast 库 |

**2026-11-10 需求方裁定（覆盖本节的「建议」）+ 事后事实核对**：

- **需求方原话**：「Select / Toast：**允许新增** `@radix-ui/react-select` 和 `sonner`。Dialog / Textarea
  只补本地源码，不新增依赖（radix-dialog 已装）。」
- **实际执行**：只装了 **`sonner@^2.0.8`**，**没有**装 `@radix-ui/react-select`。理由见下一条。
  两者关系是「允许 ≠ 必须」：需求方给的是许可上限，不是安装清单。
- **为什么跳过 `@radix-ui/react-select`**：原生 `Select` 已在 `components/ui/input.tsx:46-60`，
  `Textarea`（`:28-44`）、`Label`（`:63-72`）同文件；`app/datasets/page.tsx`、`app/runs/new/page.tsx`、
  `app/targets/page.tsx` 三处已在用。M1 的 P1/P4/P3 三个页面没有一个需要「可搜索分组下拉」这类
  Radix Select 才有的能力，装了就是零收益的额外依赖。**若后续页面需要分组/搜索型下拉，再装不迟**。
- **`Toast`**：`sonner@^2.0.8` 已装。用途限于 P4「导入成功」与 P3「已复制」。
- **`Dialog` / `Textarea`**：`Textarea` **已存在**（`input.tsx:28`），无需新增；`Dialog` 按需补本地源码
  （`@radix-ui/react-dialog` 已装，`components/ui/sheet.tsx` 就在用）。

> 🔴 **更正我自己的判断**：本文件初稿写「`Select` 与 `Toast` 都缺，建议都走零依赖」，在 `Select` 上是
> **事实错误** —— 我把 `components/ui/` 的 9 个文件当成了全部，漏看 `input.tsx` 里导出的三个组件。

### 4.2 图表（依赖 §2.2 的裁定）

两张图的形状与语义先固定下来，与库无关：

| 图 | 形式 | 数据 | 色彩职责（`DESIGN.md` §5.1） |
|---|---|---|---|
| P2 左图 | **分组柱图**，2 系列 × 6 算子 | 基线 vs 候选的算子分项分（Recall@5 / MRR / nDCG@5 / NumberFidelity / Faithfulness / JsonSchema） | 基线 = `--chart-baseline`（**刻意退后**）；候选 = `--primary`。**不用分类槽** |
| P2 右图 | **折线图**，2 系列 × N 个 case | 基线延迟 vs 候选延迟（ms） | 同上；`DESIGN.md` §5.2 第 2 条要求**实线发丝线、禁虚线**，原型的 `borderDash: [4,4]`（1564 行）**必须去掉** |

两条与原型相冲的红线：

1. **禁虚线**（§5.2 第 2 条）：原型基线用 `borderDash: [4,4]`，本项目基线用**实线 + 退后灰**。
2. **每张图必须有表格视图孪生**（§5.2 第 3 条）：原型没有，本项目要补「图表 / 表格」切换。

---

## 5. 阻塞与冲突清单（这些**不是**抽取能解决的，需要裁定）

按严重程度排序。**C1 会直接卡住第 3 批；C2/C4 决定第 5 批能不能开工。**

### C1 · 图表库（✅ 已裁定：`echarts@^5.6.0` 已装，但第 3 批仍按方案 A 不出图） — 详见 §2.2

`package.json` 现已声明 `echarts@^5.6.0`。**库已就位，但 P2 页面本身仍缺路由/接口/数据**，
因此「装了库」不改变 P2 在 M1 不可实现这一事实（C2 仍然是硬阻塞）。

### C2 · P2 / P5 / P6 三个区块在 M1 没有路由、没有接口、没有表数据（🔴 阻塞第 5 批）

| 区块 | 原型页面 | 本项目对应 | 里程碑 | 缺什么 |
|---|---|---|---|---|
| P2 AB 对比 + 门禁横幅 | `PG-08` | **无路由** | **M3** | 无 `/api/runs/compare`；`baselines` 表 ❌ 空表；`regression_gates` / `gate_evaluations` ❌ 空表（`SPEC-M1` §1.1 第 12–14 行） |
| P5 算子库 + 沙箱 | `PG-07` | **无路由** | **M4** | `evaluators` 表 ❌ 空表（§1.1 第 8 行）；无 `GET /api/evaluators`；无算子试跑端点 |
| P6 网关 + CI | `PG-09` | **无路由** | **M2**（网关 Tab）/ **M4**（门禁规则 Tab） | 无 `POST /api/providers`；`POST /api/providers/{id}/probe` 契约尚未存在（`milestones.md` §3 已登记）；无 webhook 端点 |

补齐它们需要：**新增契约**（`SPEC-M1` §1.2 明令「不得新增 / 修改任何契约文件」）、
**新增表与迁移**（不在 M1 的 18 个迁移里）、**新增路由**（`SPEC-M1` §1.3 只列 5 条）。
三者中任何一项都超出 M1 授权范围。

**我的判断（供你否决）**：第 5 批应**只做 P4**，P2/P5/P6 的布局骨架可以抽出来当**占位页**
（`disabled` 导航 + 「P1 支持」标注，与现有 `lib/ui/nav.ts` 的处理一致），
但不连数据、不写图表、不加接口。若你要的是「把原型整体搬过来跑起来」，
那已不是 M1 的范围，需要先改里程碑。

### C3 · 侧边导航结构冲突（🟡 影响第 1 批）

原型：2 个分组、5 个导航项、1 张门禁图例卡、1 个抽屉触发按钮。
本项目：`lib/ui/nav.ts` 被单测锁死为 **4 个分区**、M1 只渲染「运行」「资产」
（`DESIGN.md` §1.3 第 4 条 + `SPEC-M1` §1.3）。

→ 第 1 批只做**布局骨架**（宽度/高度/内边距/折叠），导航项**沿用现有 `nav.ts`**，
不新增第 5 个分区、不加门禁图例卡、不加抽屉入口。

### C4 · P4 卡片网格 vs SPEC 的 6 列表格（🟡 影响第 5 批）

| 来源 | 形态 |
|---|---|
| 原型（475 行） | `grid-cols-1 md:grid-cols-2` 卡片网格 |
| `SPEC-M1` `[FE-02]` 交付物 1（`:420`） | 表格，列 `名称 ｜ 最新版本 ｜ 条目数 ｜ 来源 ｜ 最近更新 ｜ 操作` + 上传面板 + 版本历史内联展开 |
| `DESIGN.md` §1.3 第 1 条 | 筛选器只有一行、置于**表格**上方 |
| `AS-3` / `DESIGN.md` §6.1 | **每个数据表格**必须完整三态 —— 卡片网格没有「三态」这一说，`DataTable` 的现成能力也用不上 |

→ `工程规则.md` §3「契约与 SPEC 先行」优先于原型。**我倾向按 SPEC 做表格**，
卡片可作为表格行展开后的「详情卡」。这条需要你裁，因为简报里点名要「数据集卡片 2 列网格」。

### C5 · P3 抽屉宽度 740 vs 720 vs 680–760（🟢 一句话就能定）

- 原型：注释写 720px（602 行），类名写 `max-w-[740px]`（605 行）—— **原型自己前后不一**。
- 简报：740px。
- `DESIGN.md` §1.2：680–760px。
- 现有 `SheetContent`：`default` 680px / `wide` 760px（`sm:w-[720px]` 是基础类，被后两个覆盖）。

→ 三者**全在允许区间内**。建议取 **740px**（按简报），实现上是给 `SheetContent` 加第三档
或直接把 `wide` 调成 740px。**这条不阻塞，我会按你的口径改。**

### C6 · P1 的 KPI 卡与「准出门禁」列（🟡 影响第 2 批）

先澄清一处**容易读错**的地方：`DESIGN.md` 并不禁止 `PG-01` 有指标卡。
§1.3 第 3 条禁的是「**首页大屏 / 欢迎页 / KPI 概览仪表盘**」这种独立首页，
而 §5.1 的图表清单在「指标卡（KPI 行）」一行里点名的应用页正是 **`PG-03`、`PG-01`**，
§3.2 的强制覆盖清单也把「指标卡（KPI 行）」列为必须 `tabular-nums` 的场景。
所以 `DESIGN.md` 内部是一致的：`PG-01` 可以有 KPI 行，但不能把 KPI 做成一个单独的大屏。

真正的缺口在 `SPEC-M1`：

- `[FE-03]` 交付物 1（`:446`）对 `/runs` 只要求「列表 + 空状态 + 前置横幅」，**未列 KPI 卡**；
- 原型的「准出门禁」列依赖 `gate_evaluations`，而 M1 该表是 ❌ 空表（§1.1 第 14 行），
  也没有 `pass_rate` 之外的裁决数据可用；
- 原型 KPI 卡里的 `nDCG@5 (Trinity)`、`累积成本`、`P95` 这些跨 run 聚合值，M1 没有任何接口提供。

→ 第 2 批按 `SPEC-M1` 做：**先只有列表 + 空状态 + 前置横幅，不加 KPI 卡、不加门禁列**。
若你要 KPI 卡，需要你先定：四张卡各取什么数（都要能落到 `/api/runs` 已有字段上），
以及「准出门禁」列在 `gate_evaluations` 空表期间显示什么（空白 / 隐藏 / 「M3」占位）。
这三件事我无法从现有文档推出来。

> **复核（2026-11-11，第 2 批实现时补记）**：上面这段「不加门禁列」是**提问时**的
> 待定表述，已被 §6.1 裁定 #6 取代 —— 门禁列**要**，显示「未评估」。
> 落地口径以 `SPEC-M1` §6.5 `T-2` 为准：不填假值、不派生猜测值、不隐藏列。
> 实际实现：`准出门禁` 列插在「发起时间」与「操作」之间，单元格恒为徽章「未评估」，
> 无 `sortValue`、不接受行数据；同时删掉 SPEC 交付物清单里没有的裸「Token」列。原判定保留不删。

### C7 · `lint:design` 脚本不存在（🟢 不影响实现，影响门禁口径）

`src/package.json` 的 `scripts` 里**没有** `lint:design`。现有等价能力是三件：

| 现脚本 | 覆盖什么 |
|---|---|
| `npm run lint` | ESLint 9 flat config：`AS-1` 禁渐变、`AS-2` 禁裸 `#hex`/`[...]` 任意值 hex/内联 `style`、禁 `next/font/google`、禁 `lucide/dist` 深引、`import/no-restricted-paths` 分层边界 |
| `npm run lint:css` | stylelint `color-no-hex`（`app/**/*.css` `components/**/*.css`） |
| `npm run check:tokens` | 文本层补集扫描：`rgb(` / `hsl(`（排除 `hsl(var(`）/ 6 位 hex / `gradient(` / `style={`

→ 简报里每个批次都要求「`lint:design` 零违规」，但**不存在这个命令**。两条路：
① 加一个 alias `"lint:design": "npm run lint && npm run lint:css && npm run check:tokens"`（改 `package.json`，新增一行脚本，不是新增依赖）；
② 每批改跑上面三条。
**我倾向 ①**，因为简报里「`lint:design`」这个词在四批里出现，语义就是「三道设计门禁一起跑」。

---

## 6. 抽取完成后的下一步（等确认）

本文只做抽取，**没有改动任何代码、任何 Token、任何 SPEC**。进入第二步前需要你对四件事给口径：

### 6.1 裁定结果（2026-11-10，已全部结案）

| # | 问题 | 裁定 | 落地状态 |
|---|---|---|---|
| 1 | 图表库（§2.2 / C1） | **`echarts`** | ✅ `echarts@^5.6.0` 已装。但 P2 仍按方案 A 不出图（缺路由/接口/数据） |
| 2 | `#475569` 缺口（§2.1.1 末行） | **补 Token `--foreground-subtle`** | ✅ 已落 `DESIGN.md` §2.2 / §2.4 / §2.2.1 / §2.5 / §3.2 / §2.7 六处 + `globals.css` + `tailwind.config.ts` |
| 3 | `Select` / `Toast`（§4.1） | **允许新增两个包** | ⚠️ 实装只加了 `sonner@^2.0.8`；`@radix-ui/react-select` **未装**（原生 `Select` 已够用，理由见 §4.1） |
| 4 | P2 / P5 / P6 要不要做（C2） | **方案 A：只做 P1 / P4 / P3** | ⏳ 待第 1 批起逐批落地；三页留占位路由 + 侧栏置灰 |
| 5 | P4 形态（C4） | **按 `SPEC-M1` `[FE-02]` 6 列表格**，不按原型卡片网格 | ⏳ 第 5 批 |
| 6 | P1 KPI 卡与门禁列（C6） | **不加 KPI 行；门禁列显示「未评估」** | ✅ 已登记 `SPEC-M1` §6.5 `T-1` / `T-2` |
| 7 | `lint:design`（C7） | **加 alias** | ✅ `"lint:design": "npm run lint && npm run lint:css && npm run check:tokens"` 已写入 `package.json`，实测通过 |

其余（C3 导航结构、C5 抽屉宽度）按上文的倾向执行：C3 沿用现有 `nav.ts` 四分区、
不加门禁图例卡与抽屉入口；C5 用现有 `Sheet` 的 `width="wide"`（760px）。
