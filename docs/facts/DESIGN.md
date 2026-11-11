# 视觉与交互规范（DESIGN）

> **本文件是「视觉基调 / 色彩 Token / 字体与数字排版 / 评测专用组件 / 图表规范 / 反 AI 塑料感禁令 / 无障碍基线」的唯一事实源。**
> 页面结构、按钮文案、状态徽章语义见 [`pages-and-flows.md`](./pages-and-flows.md)；
> 前端技术栈（shadcn/ui / TanStack Table `^8` / ECharts 5 / Lucide）见 [`technical-solution.md`](./technical-solution.md) `TS-5`；
> 工程规则与 Linter 门禁见 [`../工程规则.md`](../工程规则.md) §4 / §4.1。
> 规则依据：`docs/工程规则.md` 第 1 节「单一事实源原则」。
>
> 建立日期：2026-11-07 · 状态：**已确认**（需求方 2026-11-07 四项拍板：色彩对比度修正 / Tailwind v3.4 / 字体本地打包 / `tabular-nums` 全局强制）
>
> **`globals.css` 与 `tailwind.config.ts` 是本文件的实现载体。三者必须逐值一致；冲突时以本文件为准，并回头修代码。**

---

## 0. 定位与一句话原则

**精密实验室与现代开发者控制台风格（Precision Engineering & Observability Aesthetic）。**

参考标杆：**Linear**（密度与克制）、**Langfuse**（评测域信息组织）、**Vercel Dashboard**（数值排版与留白）、**GitHub PR Diff**（双栏差异表达）。

一句话原则：

> **信息的密度与精度就是美学。留白用来分隔语义，不用来装作高级。**

本文件的存在目的，是把「不要 AI 塑料感」从一句审美口号，变成**可被 Linter 检查的硬规则**。

---

## 1. 视觉基调与布局

### 1.1 反 AI 塑料感的六条基调

| AI 生成设计的典型特征 | 本项目的处置 |
|---|---|
| 大圆角（12–16px）+ 层叠柔和投影 | `--radius: 6px`；**默认无阴影**，用 1px `--border` 分隔；只有 Overlay 层（Sheet / Dialog / Popover）允许 `--shadow-overlay` |
| 紫蓝渐变背景 / 霓虹光晕 | **全局禁令**（§7 Linter 拦截） |
| 每个卡片统一圆角、统一 `rgba(0,0,0,.1)` 投影 | 用**层级**而非阴影表达关系：页面（无表面）→ 卡片（1px 边框）→ 抽屉（边框 + 一层阴影） |
| 标题上方 ALL-CAPS 小字 eyebrow | **禁止**。表头与分组标题用 sentence case + `font-medium` + `--muted-foreground` |
| `A · B · C` 中点连接、`WORD — fragment` 破折号、链接尾缀 `→` | **禁止**（`frontend-design` 点名的 AI 生成设计 tell） |
| 每个 section 都 fade-and-slide-up 入场 | **禁止**。全站只保留**两处**编排动效：Sheet 滑入、`eval-running` 呼吸脉冲。其余动效仅响应用户操作（hover / focus / 展开） |

### 1.2 布局骨架

```
┌─ 侧边导航 220px ─┬─ 面包屑 + 全局快捷操作栏 48px ─────────────────┐
│ 运行              │  评测运行 / 客服问答集 v3 / #a1b2c3d4           │
│   评测运行台      ├──────────────────────────────────────────────────┤
│   发起评测        │  筛选行（单一，作用于其下全部内容）                │
│ 资产              │  ┌────────────────────────────────────────────┐  │
│   评测集          │  │ 主数据表（13px / 行高 36px / 表头 32px）    │  │
│   待测目标        │  │ 数字列一律右对齐 + tabular-nums            │  │
│ 算子              │  │                                            │  │
│ 管理              │  └────────────────────────────────────────────┘  │
│                   │            ┌─ Sheet 680–760px 右侧滑出 ──┐      │
└───────────────────┴────────────┴──────────────────────────────┴──────┘
```

| 尺寸 | 值 | 依据 |
|---|---|---|
| 侧边导航展开 | **220px** | 需求方指定 |
| 侧边导航折叠 | **56px**（仅图标 + tooltip） | 高密度下仍可腾出 164px 给表格 |
| 顶部栏高度 | **48px** | 单行面包屑 + 右对齐快捷操作 |
| 表格行高 | **36px** | 一屏可显示 18–20 行，仍保证 ≥24px 点击目标 |
| 表格字号 | **13px**（元数据 12px） | 开发者工具常规密度 |
| 内容区左右内边距 | **24px** | 呼吸感来源，不是靠大间距 |
| `PG-04` 抽屉宽度 | **680–760px**；`< sm`（640px）全屏 | 需求方指定 |

### 1.3 布局硬约束

1. **筛选器只有一行，置于表格上方**，作用于其下所有内容。**禁止**把筛选器塞进卡片内部或每张图各配一套（`dataviz` 反模式）。
2. **`PG-04` 是 Overlay 不是路由**：不提供直达 URL，刷新后回到 `PG-03`（`pages-and-flows.md` §6 已定）。理由：排查心流由「不跳页」保证。
3. **不设首页大屏、不设欢迎页、不设 KPI 概览仪表盘**：登录后直接进 `PG-01`（`pages-and-flows.md` §0.3）。
4. 侧边导航只有 4 个分区（运行 / 资产 / 算子 / 管理），**不得新增第 5 个分区**。

---

## 2. 色彩系统（语义 Token）

### 2.1 三条不可协商的规则

1. **业务组件中禁止出现裸 `#hex`**，一律引用语义 Token（§7 Linter 强制）。
2. **`globals.css` 是全仓库唯一允许出现 hex/HSL 数值的文件**。`tailwind.config.ts` 只允许写 `hsl(var(--…))`。
3. **每个 Token 必须有浅色与深色两个值**。深色不是"自动反转"，是**单独选定**并对深色表面验证过对比度的一组值。

**序列化格式**：Tailwind **v3.4** + HSL 通道三元组 + `tailwind.config.ts`（需求方拍板：稳定优先）。
> 若将来升 v4（CSS-first），**Token 名一个不改**，只换序列化格式；届时本文件的语义层零变更。

### 2.2 基础 Token（浅色 · 主）

| Token | 浅色值 | hex | 用途 |
|---|---|---|---|
| `--background` | `210 40% 98%` | `#F8FAFC` | 主画布 |
| `--foreground` | `222 47% 11%` | `#0F172A` | 主标题 / 核心指标 |
| `--card` | `0 0% 100%` | `#FFFFFF` | 卡片与表格主表面 |
| `--card-foreground` | `222 47% 11%` | `#0F172A` | — |
| `--muted` | `210 40% 96%` | `#F1F5F9` | 代码块 / Prompt 对比底 |
| `--muted-foreground` | `215 16% 47%` | `#64748B` | 次要元数据 / 时间戳 |
| `--body-foreground` | `215 25% 27%` | `#334155` | 正文（介于前景与次要之间，避免整页过黑） |
| `--foreground-subtle` | `215 19% 35%` | `#475569`（渲染 `#48566A`） | **11px 时间戳 / 细粒度元数据**（实测 7.13 on `#F8FAFC`，7.46 on `#FFFFFF`）。见 §2.2.1 |
| `--border` | `214 32% 91%` | `#E2E8F0` | 1px 分隔线 / 表格框线 |
| `--input` | `214 32% 91%` | `#E2E8F0` | 输入框边框 |
| `--ring` | `221 83% 53%` | `#2563EB` | `:focus-visible` 焦点环 |
| `--primary` | `221 83% 53%` | `#2563EB` | 品牌 / 主操作（沉稳科技靛蓝） |
| `--primary-foreground` | `0 0% 100%` | `#FFFFFF` | 主操作按钮文字 |
| `--radius` | `6px` | — | 全局圆角 |

<a id="2-2-1"></a>
#### 2.2.1 `--foreground-subtle` 说明（2026-11-10 新增）

> 为什么单独加一档：§2.5 与 §3.2 都要求「11px 时间戳必须用 `#475569`」，但 §2.2 此前**没有**任何浅色 Token 落在 `#475569`——它只作为 §2.6 的 `--chart-axis` **深色值**存在。也就是说规范引用了一个不存在的 Token，实现时只能写裸 hex（违规）或退回 `--muted-foreground` `#64748B`（只有 4.53，且明确标注「仅限 ≥12px」，用于 11px 不合规）。因此补 `--foreground-subtle`。
>
> - **浅色** `215 19% 35%` → 渲染 `#48566A`（`DESIGN.md` 沿用「HSL 整数四舍五入」写法，与 `--muted-foreground` 同一约定：`215 16% 47%` 名义 `#64748B`、渲染 `#65758B`）。实测 **7.13** on `#F8FAFC` / **7.46** on `#FFFFFF`；若严格取 `#475569` 字面值则为 7.24 / 7.58，两者都远超 AA 4.5。
> - **深色** `215 17% 60%` = `#8896AA`，实测 **5.94** on `#0F172A` / **4.87** on `#1E293B`。深色下它比 `--body-foreground` `#94A3B8`（6.96）**更暗一档**，保持「subtle 比正文弱」的层级；同时仍 ≥ AA 4.5，11px 可用。
> - 层级：`--foreground`（核心）＞ `--body-foreground`（正文）＞ `--foreground-subtle`（11px 时间戳）＞ `--muted-foreground`（≥12px 次要元数据）。

### 2.3 评测专用扩展 Token（**极关键**）

> **三档结构**：`fg`（文字）/ `bg`（胶囊底）/ `mark`（图标、描边、进度填充）。
> 之所以拆三档，是因为需求方选定的 600 级色号**作为文字色不达 WCAG AA**（§2.5 实测）。600 级全部保留，但降级为 `mark`；文字改用 700–800 级。**颜色气质不变，只改它出现在哪一层。**

| 语义 | Token | 浅色值 | hex | 实测对比度 | 用途 |
|---|---|---|---|---|---|
| 通过 / 提升 | `--eval-pass-fg` | `159 94% 27%` | `#047857` | **5.21** ✅ | 差值文字、徽章文字 |
| | `--eval-pass-bg` | `152 81% 96%` | `#ECFDF5` | — | 胶囊底 |
| | `--eval-pass-mark` | `160 84% 39%` | `#059669` | 3.58（图形 ≥3 ✅） | `▲` 图标 / 描边 / 进度填充 |
| 退化 / 阻断 | `--eval-fail-fg` | `0 75% 43%` | `#B91C1C` | **5.91** ✅ | 差值文字、徽章文字 |
| | `--eval-fail-bg` | `0 86% 97%` | `#FEF2F2` | — | 胶囊底 |
| | `--eval-fail-mark` | `0 72% 51%` | `#DC2626` | 4.41（图形 ✅） | `▼` 图标 / 描边 |
| 轻微波动 / 部分失败 | `--eval-warn-fg` | `26 90% 37%` | `#B45309` | **4.84** ✅ | 徽章文字 |
| | `--eval-warn-bg` | `48 100% 96%` | `#FFFBEB` | — | 胶囊底 |
| | `--eval-warn-mark` | `32 95% 44%` | `#D97706` | 3.07（图形 ✅） | 图标 / 描边 |
| 运行中（SSE） | `--eval-running-fg` | `201 96% 32%` | `#0369A1` | **5.17** ✅（对 bg） | 徽章文字 |
| | `--eval-running-bg` | `204 94% 94%` | `#E0F2FE` | — | 胶囊底 |
| | `--eval-running-mark` | `200 98% 40%` | `#0284C7` | 4.10（图形 ✅） | 呼吸脉冲点 |
| Diff 基线删除 | `--diff-del-fg` | `343 80% 35%` | `#9F1239` | **6.63** ✅ | 删除行文字 |
| | `--diff-del-bg` | `356 100% 95%` | `#FFE4E6` | — | 删除行底色 |
| Diff 当前新增 | `--diff-add-fg` | `143 60% 24%` | `#166534` | **6.49** ✅ | 新增行文字 |
| | `--diff-add-bg` | `141 84% 93%` | `#DCFCE7` | — | 新增行底色 |

### 2.4 深色模式（单独选定，非反转）

| Token | 深色值 | hex |
|---|---|---|
| `--background` | `222 47% 11%` | `#0F172A` |
| `--foreground` | `210 40% 98%` | `#F8FAFC` |
| `--card` | `217 33% 17%` | `#1E293B` |
| `--card-foreground` | `210 40% 98%` | `#F8FAFC` |
| `--muted` | `217 33% 17%` | `#1E293B` |
| `--muted-foreground` | `215 20% 65%` | `#94A3B8` |
| `--body-foreground` | `215 20% 65%` | `#94A3B8` |
| `--foreground-subtle` | `215 17% 60%` | `#8896AA` |
| `--border` | `215 25% 27%` | `#334155` |
| `--input` | `215 25% 27%` | `#334155` |
| `--ring` | `217 91% 60%` | `#3B82F6` |
| `--primary` | `217 91% 60%` | `#3B82F6` |
| `--primary-foreground` | `222 47% 11%` | `#0F172A` |
| `--eval-pass-fg` | `158 64% 52%` | `#34D399` |
| `--eval-pass-bg` | `164 42% 16%` | `#064E3B` |
| `--eval-pass-mark` | `158 64% 52%` | `#34D399` |
| `--eval-fail-fg` | `0 91% 71%` | `#F87171` |
| `--eval-fail-bg` | `0 63% 15%` | `#450A0A` |
| `--eval-fail-mark` | `0 91% 71%` | `#F87171` |
| `--eval-warn-fg` | `43 96% 56%` | `#FBBF24` |
| `--eval-warn-bg` | `21 92% 14%` | `#451A03` |
| `--eval-warn-mark` | `43 96% 56%` | `#FBBF24` |
| `--eval-running-fg` | `198 93% 60%` | `#38BDF8` |
| `--eval-running-bg` | `204 80% 16%` | `#082F49` |
| `--eval-running-mark` | `198 93% 60%` | `#38BDF8` |
| `--diff-del-fg` | `353 96% 82%` | `#FDA4AF` |
| `--diff-del-bg` | `343 88% 16%` | `#4C0519` |
| `--diff-add-fg` | `142 72% 73%` | `#86EFAC` |
| `--diff-add-bg` | `145 80% 10%` | `#052E16` |

> 深色下 `fg` 与 `mark` 同值：深色表面亮度低，400 级已同时满足文字 4.5:1 与图形 3:1，无需再拆。

### 2.5 对比度实测记录（可复算，非目测）

计算公式：sRGB → 线性化 → 相对亮度 `L` → `(L1+0.05)/(L2+0.05)`。判定阈值依 WCAG 2.2：正文 4.5:1，图形与大字号 3:1。

| 组合 | 比值 | 判定 |
|---|---|---|
| `#047857` on `#ECFDF5` | 5.21 | ✅ |
| `#B91C1C` on `#FEF2F2` | 5.91 | ✅ |
| `#B45309` on `#FFFBEB` | 4.84 | ✅ |
| `#0369A1` on `#E0F2FE` | 5.17 | ✅ |
| `#9F1239` on `#FFE4E6` | 6.63 | ✅ |
| `#166534` on `#DCFCE7` | 6.49 | ✅ |
| `#2563EB` on `#FFFFFF` | 5.17 | ✅ |
| `#0F172A` on `#F8FAFC` | 17.07 | ✅ |
| `#334155` on `#FFFFFF` | 10.36 | ✅ |
| `#64748B` on `#F8FAFC` | 4.53 | ✅（**仅限 ≥12px**）|
| `#475569` on `#F8FAFC` | 7.24 | ✅（11px 时间戳必须用它 → `--foreground-subtle`）|
| `#475569` on `#FFFFFF` | 7.58 | ✅（同上，卡片表面）|
| `#48566A` on `#F8FAFC` | 7.13 | ✅（`--foreground-subtle` 实际渲染值，仍远超 AA）|
| `#8896AA` on `#0F172A` | 5.94 | ✅（`--foreground-subtle` 深色，11px 可用）|
| `#8896AA` on `#1E293B` | 4.87 | ✅（同上，卡片表面）|
| **原始** `#059669` on `#ECFDF5` | **3.58** | ❌ → 降为 `mark` |
| **原始** `#DC2626` on `#FEF2F2` | **4.41** | ❌ → 降为 `mark` |
| **原始** `#D97706` on `#FFFBEB` | **3.07** | ❌ → 降为 `mark` |
| **原始** `#0284C7` on `#FFFFFF` | **4.10** | ❌ → 降为 `mark` |

> ⚠️ **未验证项**：CVD（色盲）分离度与深色模式全部组合的对比度，需用 `dataviz` 技能内的 `scripts/validate_palette.js` 计算。**校验器在本轮被安全分类器拦截**，由需求方在本地终端补跑（见 §9）。

### 2.6 图表 chrome Token

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--chart-1` | `213 68% 50%` `#2A78D6` | `213 77% 56%` `#3987E5` | 分类槽 1 |
| `--chart-2` | `17 82% 56%` `#EB6834` | `17 70% 50%` `#D95926` | 分类槽 2 |
| `--chart-3` | `159 73% 40%` `#1BAF7A` | `159 73% 36%` `#199E70` | 分类槽 3 |
| `--chart-4` | `41 100% 46%` `#EDA100` | `40 100% 39%` `#C98500` | 分类槽 4 |
| `--chart-5` | `337 70% 70%` `#E87BA4` | `338 61% 58%` `#D55181` | 分类槽 5 |
| `--chart-baseline` | `215 16% 47%` `#64748B` | `215 20% 65%` `#94A3B8` | **基线系列**（刻意退后） |
| `--chart-grid` | `214 32% 91%` `#E2E8F0` | `215 25% 27%` `#334155` | 网格发丝线 |
| `--chart-axis` | `212 27% 84%` `#C7D2E0` | `215 25% 35%` `#475569` | 坐标轴 / 零线 |
| `--shadow-overlay` | `0 8px 24px rgb(15 23 42 / 0.08)` | `0 8px 24px rgb(0 0 0 / 0.40)` | Overlay 层专用投影 |

> **`--chart-3` / `--chart-4` / `--chart-5` 在浅色表面对比度低于 3:1**（实测 2.82 / 2.17 / 2.69）。因此对使用这三个槽位的图，**必须**开启 `dataviz` 的 relief rule：可见的直接标注 + 表格视图孪生。这是已知代价，不是可以忽略的告警。

### 2.7 `globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 210 40% 98%;
    --foreground: 222 47% 11%;
    --body-foreground: 215 25% 27%;
    --foreground-subtle: 215 19% 35%;
    --card: 0 0% 100%;
    --card-foreground: 222 47% 11%;
    --muted: 210 40% 96%;
    --muted-foreground: 215 16% 47%;
    --border: 214 32% 91%;
    --input: 214 32% 91%;
    --ring: 221 83% 53%;
    --primary: 221 83% 53%;
    --primary-foreground: 0 0% 100%;
    --radius: 6px;

    --eval-pass-fg: 159 94% 27%;
    --eval-pass-bg: 152 81% 96%;
    --eval-pass-mark: 160 84% 39%;
    --eval-fail-fg: 0 75% 43%;
    --eval-fail-bg: 0 86% 97%;
    --eval-fail-mark: 0 72% 51%;
    --eval-warn-fg: 26 90% 37%;
    --eval-warn-bg: 48 100% 96%;
    --eval-warn-mark: 32 95% 44%;
    --eval-running-fg: 201 96% 32%;
    --eval-running-bg: 204 94% 94%;
    --eval-running-mark: 200 98% 40%;

    --diff-del-fg: 343 80% 35%;
    --diff-del-bg: 356 100% 95%;
    --diff-add-fg: 143 60% 24%;
    --diff-add-bg: 141 84% 93%;

    --chart-1: 213 68% 50%;
    --chart-2: 17 82% 56%;
    --chart-3: 159 73% 40%;
    --chart-4: 41 100% 46%;
    --chart-5: 337 70% 70%;
    --chart-baseline: 215 16% 47%;
    --chart-grid: 214 32% 91%;
    --chart-axis: 212 27% 84%;

    --shadow-overlay: 0 8px 24px rgb(15 23 42 / 0.08);
  }

  .dark {
    --background: 222 47% 11%;
    --foreground: 210 40% 98%;
    --body-foreground: 215 20% 65%;
    --foreground-subtle: 215 17% 60%;
    --card: 217 33% 17%;
    --card-foreground: 210 40% 98%;
    --muted: 217 33% 17%;
    --muted-foreground: 215 20% 65%;
    --border: 215 25% 27%;
    --input: 215 25% 27%;
    --ring: 217 91% 60%;
    --primary: 217 91% 60%;
    --primary-foreground: 222 47% 11%;

    --eval-pass-fg: 158 64% 52%;
    --eval-pass-bg: 164 42% 16%;
    --eval-pass-mark: 158 64% 52%;
    --eval-fail-fg: 0 91% 71%;
    --eval-fail-bg: 0 63% 15%;
    --eval-fail-mark: 0 91% 71%;
    --eval-warn-fg: 43 96% 56%;
    --eval-warn-bg: 21 92% 14%;
    --eval-warn-mark: 43 96% 56%;
    --eval-running-fg: 198 93% 60%;
    --eval-running-bg: 204 80% 16%;
    --eval-running-mark: 198 93% 60%;

    --diff-del-fg: 353 96% 82%;
    --diff-del-bg: 343 88% 16%;
    --diff-add-fg: 142 72% 73%;
    --diff-add-bg: 145 80% 10%;

    --chart-1: 213 77% 56%;
    --chart-2: 17 70% 50%;
    --chart-3: 159 73% 36%;
    --chart-4: 40 100% 39%;
    --chart-5: 338 61% 58%;
    --chart-baseline: 215 20% 65%;
    --chart-grid: 215 25% 27%;
    --chart-axis: 215 25% 35%;

    --shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.40);
  }

  * { @apply border-border; }

  body {
    @apply bg-background text-foreground antialiased;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
}

@layer utilities {
  /* 数字对齐铁律（§3.2）：全局强制，含指标卡 */
  .num {
    font-variant-numeric: tabular-nums slashed-zero;
  }
  .num-mono {
    font-family: "JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace;
    font-variant-numeric: tabular-nums slashed-zero;
  }
}
```

### 2.8 `tailwind.config.ts`（节选）

```ts
import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        body: 'hsl(var(--body-foreground))',
        subtle: 'hsl(var(--foreground-subtle))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        eval: {
          pass:    { DEFAULT: 'hsl(var(--eval-pass-fg))',    bg: 'hsl(var(--eval-pass-bg))',    mark: 'hsl(var(--eval-pass-mark))' },
          fail:    { DEFAULT: 'hsl(var(--eval-fail-fg))',    bg: 'hsl(var(--eval-fail-bg))',    mark: 'hsl(var(--eval-fail-mark))' },
          warn:    { DEFAULT: 'hsl(var(--eval-warn-fg))',    bg: 'hsl(var(--eval-warn-bg))',    mark: 'hsl(var(--eval-warn-mark))' },
          running: { DEFAULT: 'hsl(var(--eval-running-fg))', bg: 'hsl(var(--eval-running-bg))', mark: 'hsl(var(--eval-running-mark))' },
        },
        diff: {
          del: { bg: 'hsl(var(--diff-del-bg))', fg: 'hsl(var(--diff-del-fg))' },
          add: { bg: 'hsl(var(--diff-add-bg))', fg: 'hsl(var(--diff-add-fg))' },
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          baseline: 'hsl(var(--chart-baseline))',
          grid: 'hsl(var(--chart-grid))',
          axis: 'hsl(var(--chart-axis))',
        },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      boxShadow: { overlay: 'var(--shadow-overlay)' },
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '18px'],
        sm: ['13px', '20px'],
        base: ['14px', '22px'],
      },
      keyframes: {
        'eval-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
      },
      animation: { 'eval-pulse': 'eval-pulse 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite' },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;
```

---

## 3. 字体、排版与数字对齐铁律

### 3.1 字体栈（全部本地，零外网请求）

| 用途 | 栈 |
|---|---|
| 正文 / UI | `-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` |
| 代码 / 数值 | `"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace` |

**本地打包（需求方拍板）**：`Inter` 与 `JetBrains Mono` 必须经 `next/font/local` 或 npm 包（`@fontsource/inter` / `@fontsource/jetbrains-mono`）**打包进产物**。

> 为什么必须打包而不是"系统有就用"：字体栈是**按序回退**的。若 `Inter` 未打包，在 macOS 上会命中 `-apple-system`、在 Windows 上会命中 `Microsoft YaHei`——**同一份代码在两台机器上渲染出不同字重与行高**，「桌面尺寸不吃网络」这条承诺就落空了。
> **明令禁止**：`next/font/google`、任何 CDN 字体 `<link>`（构建期联网，内网必挂）。见 `工程规则.md` §9。

### 3.2 🔒 `tabular-nums` 全局强制令

> **所有指标分数、耗时、Token 数、金额、计数所在的表格列、指标卡、徽章、坐标轴刻度，一律使用 `tabular-nums`。**

强制覆盖清单：

| 场景 | 示例 | 附加要求 |
|---|---|---|
| 表格数字列 | `0.9952` / `1,240 ms` / `$0.0428` | **右对齐**（数字列默认 `text-right`） |
| 指标卡（KPI 行） | 综合得分 / 通过率 / 覆盖率 / P50 / P95 | 宽度用 `ch` 固定，防跳动 |
| 徽章 | `0.9586 (+0.0366 ▲)` | 当前分与差值都套 |
| 坐标轴刻度 / tooltip 数值 | `0.85` | ECharts 主题里统一设 |
| 进度计数 | `42 / 50 Cases` | — |
| 时间戳 | `2026-11-07 14:32:08` | 用等宽栈，不用 `tabular-nums` 数字字体也齐 |

**同时强制 `slashed-zero`**：数据工具里 `0` 与 `O` 混淆是真实的读数错误来源。

#### 对 `dataviz` 技能的知情偏离（已记录理由）

`dataviz` 的反模式清单写明：**「`tabular-nums` 加在大号独立数字上是反模式——等宽数字会让 `121` 在展示级字号下显得松散」**，主张指标卡用比例数字。

**本项目不采纳这条，理由比审美更硬**：

> `PG-03` 的综合得分、已耗成本、Token 数是**每来一条 `case` 事件就变一次**的实时值。
> 若用比例数字，`0.9586 → 0.9601 → 0.9487` 每次变化**字符宽度都不同**，整个指标卡会横向抖动。
> 在持续刷新的面板上，这是可感知的视觉噪声，会持续分散注意力。
> **`tabular-nums` 是消除这处抖动的唯一手段。**

**结论：`tabular-nums` 全局强制，不接受"大字号"例外。** 这是一处**有记录的、有理由的**偏离，不是疏忽。

### 3.3 数字格式表（对齐的前提）

| 指标 | 格式 | 示例 |
|---|---|---|
| 综合得分 / 算子得分 | 固定 4 位小数 | `0.9952` |
| 分差（分数空间） | 带符号 4 位 + 箭头 | `+0.0366 ▲` |
| 通过率 / 覆盖率 | 固定 2 位 + `%`，**不省尾零** | `84.50%` |
| 分差（百分比） | 带符号 2 位 | `▼ -4.20%` |
| 延迟 | 整数 + 千分位 + `ms` | `1,240 ms` |
| Token | 整数 + 千分位 | `128,450` |
| 单条成本 | 4 位小数 USD | `$0.0428` |
| 汇总费用 | 2 位小数 USD | `$12.48` |
| 时间戳 | `YYYY-MM-DD HH:mm:ss` | `2026-11-07 14:32:08` |
| 批次 ID / Trace ID / Hash | 等宽，超 12 位中间省略 + 可复制 | `a1b2c3d4…9f0e` |

> **固定小数位不是洁癖**：`0.995` / `0.9952` / `0.99` 混排时，即使有 `tabular-nums`，小数点也不在同一列。格式统一是对齐的**前置条件**。

### 3.4 字重与行高

| 层级 | 字号 | 字重 | 颜色 Token |
|---|---|---|---|
| 页面标题 | 20px | 600 | `--foreground` |
| 区块标题 | 14px | 600 | `--foreground` |
| 表头 | 12px | 500 | `--muted-foreground` |
| 正文 / 表格单元 | 13px | 400 | `--body-foreground` |
| 元数据 / 时间戳 | 11–12px | 400 | 12px → `--muted-foreground`；**11px → `--foreground-subtle`（`#475569`/`#8896AA`，§2.2.1）** |
| 指标卡数值 | 28px | 600 | `--foreground` + `.num` |
| 指标卡标签 | 12px | 400 | `--muted-foreground` |

**正文行高 1.5–1.6**；表格单元行高由行高 36px 决定，不单独设 `line-height`。

---

## 4. 核心评测专用组件规范（shadcn/ui 组合封装）

> 三个组件是 M1 / M2 / M3 的交付物，**接口与行为在此锁定**，实现细节留给 SPEC。

### 4.1 `<MetricDeltaBadge />`

**用途**：`PG-08` 汇总对比、`PG-03` 指标卡、`PG-01` 综合得分列。

```
┌──────────────────────────────┐
│ 0.9586   +0.0366 ▲           │   ← 胶囊，eval-pass 底
└──────────────────────────────┘
```

| 项 | 规则 |
|---|---|
| 基础组件 | shadcn/ui `Badge`，`variant="eval"` |
| 结构 | 当前分 + 差值 + 方向图标，三段均 `.num` |
| 正负映射 | `delta > 0` → `eval.pass`；`delta < 0` → `eval.fail`；`\|delta\| < 阈值` → `muted` |
| 图标 | Lucide `TrendingUp` / `TrendingDown`，**`aria-hidden`**（方向由文字 `▲/▼` + 符号表达） |
| 颜色不足依赖 | 差值文字自带 `+`/`−` 符号与箭头 —— **颜色不是唯一编码**（WCAG 1.4.1） |
| 无基线 | **不渲染 `+0.0000`**，渲染文字 `无基线`（medium 灰）。`+0` 会被读成"没变化"，与"没有可比对象"是两件事 |
| 不可比 | 任一侧 `score = null` → 渲染 `不可比`，不渲染差值（`technical-solution.md` §3.6 第 3 步） |
| 无障碍 | `role="status"`；`aria-label` 读作「当前 0.9586，较基线上升 0.0366」 |

### 4.2 `<LiveRunProgressBar />`

**用途**：`PG-03` 区域 3。数据源**唯一**：SSE `CaseEvent` 的 `completedCount` / `totalCount` / `score` / `passed` / `status` / `latencyMs`（`src/contracts/src/sse.ts`）。

```
已完成 42 / 50 Cases   3.2 cases/s   $0.0184   ● 实时更新中
[████████████████░░░░░░░░░░░░░░░░]
```

| 项 | 规则 |
|---|---|
| 布局 | 上行三段计数 + 连接指示灯；下行进度条 |
| 宽度稳定 | 计数 / 速率 / 成本三段均 `.num` + `min-w-[Nch]`，**数字变化不得推挤布局** |
| 连接三态 | `已连接`（`eval.running` + 呼吸脉冲）/ `重连中`（`eval.warn`，**静态**）/ `已断开`（`eval.fail`，静态） |
| 呼吸脉冲 | `animate-eval-pulse` 施加在 **8px 圆点**上，**不是整个徽章**（大面积脉冲是闪烁风险）；`prefers-reduced-motion: reduce` 时降级为静态实心点 |
| 无障碍 | 外层 `aria-live="polite"` + `aria-atomic="false"`；**只播报连接态变化与里程碑（每 10%）**，不播报每条 Case，否则读屏会被刷爆 |
| 断线语义 | 严格遵守 `PROGRESS_RESUME_POLICY.mode = 'snapshot_only'`：断线后先 `GET /api/runs/:id` 拉全量快照，再续订 `/stream`。**禁止制造"事件已补齐"的假象** |
| 成本口径 | 成本**只由我方 `model_prices` 计算**（`technical-solution.md` TS-2 红线），永不来自 LiteLLM |
| 空闲态 | `PENDING` 显示「等待调度」而非 `0 / 0 Cases`（后者读作"空任务"） |

### 4.3 `<CaseDiffSheet />`

**用途**：`PG-04`。shadcn/ui `Sheet`（`side="right"`）+ `ScrollArea` + `Tabs` + `Accordion`。

```
┌────────────────────── Sheet 720px ──────────────────────┐
│ case-00142        [0.72 ▸ 0.41]        J 上一条 K 下一条 ✕│  ← 固定头
├──────────────────────────────────────────────────────────┤
│ [ 并排对比 ] [ 行内对比 ]                                 │  ← Tabs
│                                                          │
│  基线 v2                          当前 v3                 │
│ ┌──────────────────────┬──────────────────────┐          │
│ │ − 检索返回 3 条切片    │ + 检索返回 1 条切片   │          │  ← diff-del / diff-add
│ │ − 答案包含退款政策     │ + 答案未提及退款      │          │
│ └──────────────────────┴──────────────────────┘          │
│                                                          │
│ ▸ 检索切片（3）                                           │  ← Accordion，默认收起
│ ▸ 裁判评语 · 忠实度 0.3                                    │
└──────────────────────────────────────────────────────────┘
```

| 项 | 规则 |
|---|---|
| 固定头 | `case_key`（等宽）+ 得分对比条（`MetricDeltaBadge` 横排）+ 上一条/下一条 + 关闭 |
| 中段 Tabs | **并排对比（Split View）** / **行内对比（Unified View）**。P0 只有当前输出时，两个 Tab 均可用（行内退化为单侧 + 行号） |
| 底部 Accordion | 检索切片（`doc_id` + 片段 + 相关度）/ 裁判思维链评语（`reason`，等宽，默认收起） |
| Diff 高亮 | 仅 `diff.add` / `diff.del` 两色；**删除行必带 `−` 前缀、新增行必带 `+` 前缀** —— 颜色不作唯一编码 |
| 键盘 | `J` 下一条 / `K` 上一条，监听挂在 **Sheet 容器**上；`Esc` 关闭优先级最高 |
| ⚠️ 键盘作用域 | 当 `document.activeElement` 落在 `input` / `textarea` / `[contenteditable]` / `select` 内时，**一律不拦截 `J`/`K`**。否则用户无法在这三条输入框里打字母 `j` 和 `k` |
| 焦点 | Sheet 是模态：必须 `focus trap` + 打开时聚焦到 Sheet 容器 + 关闭时焦点归还触发元素 |
| 滚动 | 中段用 `ScrollArea` 独立滚动，**头部与 Tab 不随内容滚走**（排查时需要随时看到 Case ID 与得分） |
| 空态 | 无参考答案 → 「本条未提供参考答案」；无基线 → 「暂无基线，仅显示本次输出」（`pages-and-flows.md` §5 原文，不得改写） |

### 4.4 状态徽章（`RS-01`…`RS-06`）

> 语义与文案的事实源是 `pages-and-flows.md` §4.1。本表只补**视觉映射**。

| 状态 | 文案 | Token | 图标 |
|---|---|---|---|
| `PENDING` | 待执行 | `muted` | Lucide `Clock` |
| `RUNNING` | 运行中 | `eval.running` + 呼吸脉冲 | `Loader`（脉冲点） |
| `COMPLETED` | 已完成 | `eval.pass` | `CircleCheck` |
| `PARTIAL_FAILED` | 部分失败 | `eval.warn` | `TriangleAlert` |
| `FAILED` | 失败 | `eval.fail` | `CircleX` |
| `CANCELLED` | 已中止 | `muted` | `CircleSlash` |

> **`FAILED` 与 `PARTIAL_FAILED` 必须一眼可分**（`pages-and-flows.md` §4.1 已拍板）：红 vs 橙、`CircleX` vs `TriangleAlert`、文案不同 —— 三重区分，不靠颜色一项。
> **Lucide 图标名跨大版本会改**（`AlertTriangle` → `TriangleAlert`），必须锁小版本并禁止深引 `lucide/dist`（`technical-solution.md` TS-5）。

---

## 5. 图表规范

### 5.1 图表清单与色彩职责

| 图 | 页面 | 形式 | 色彩职责 | 硬规则 |
|---|---|---|---|---|
| 算子雷达图 | `PG-03`、`PG-08` | 2 系列雷达 | **基线 = `--chart-baseline`（实线 2px）；当前 = `--primary`（实线 2px）**；面积填充 `0.08` / `0.12` | 基线语义上是"退后参照物"，**不是第二个身份**，因此不用分类槽；≥2 系列必带图例 |
| 算子分差图 | `PG-08` | 水平发散条 | 正 = `eval.pass.mark`，负 = `eval.fail.mark`，零线 = `--chart-axis` | 发散 = 两极性色 + 中性灰中点；每条必须带 `▲/▼` + 数值 |
| 指标卡（KPI 行） | `PG-03`、`PG-01` | **不是图表** | — | 一个数字就是全部信息。**禁止**给它配单柱、甜甜圈或迷你环 |

### 5.2 十条不可违反的图表红线

1. **绝不双 Y 轴**。两个量纲不同 → 两张图、小多图，或都指数化到基准 100 放一张图。
2. **网格线与坐标轴用实线发丝线**，禁止虚线（虚线读作"预测/阈值"）。
3. **每张图必须有表格视图孪生**。`PG-03` 的明细表本身就是孪生；`PG-08` 必须提供「图表 / 表格」切换。
4. **颜色跟随实体，不跟随排名**。筛选掉一个系列，剩下的不许换色。
5. **分类色固定顺序、永不循环**。第 6 个系列起折叠为「其他」或拆小多图，**绝不生成新 hue**。
6. **`chart-3`（青绿）与 `eval-pass` 同属绿色族**，不得与通过/失败状态提示出现在同一张图内（状态色是保留色，不得冒充系列色）。
7. **`chart-3` / `chart-4` / `chart-5` 在浅色表面 < 3:1**，凡使用它们必须开启 relief rule（可见直接标注 + 表格视图）。
8. **Tooltip 只做增强**，不得成为读数的唯一途径；键盘焦点须显示与 hover 相同的信息。
9. **图表容器高度必须容纳坐标轴标签**，不得让卡片内部出现二级滚动条。
10. **ECharts 主题必须从 Token 生成一次**（`lib/charts/theme.ts`），**禁止在 `option` 里写裸 `#hex`**（`technical-solution.md` TS-5 已点名这条短板）。

### 5.3 标记规格（来自 `dataviz`）

- 细线条：线宽 **2px**，标记点 ≥ **8px**
- 数据端：柱/条末端 **4px 圆角**，锚定基线
- 间隔：堆叠段与相邻柱之间留 **2px 表面色间隙**（不是描边）
- 重叠标记：**2px 表面色环**
- 直接标注：**选择性**（端点、极值、最关心的那一个），**绝不每个点都写数字**

---

## 6. 交互与状态完整性

### 6.1 每个数据表格必须完整实现的三态

| 态 | 要求 | 反例 |
|---|---|---|
| **空状态** | 真实文案 + 主行动链接，文案取自 `pages-and-flows.md` §5 原文 | 「暂无数据」 |
| **加载** | `shadcn/ui Skeleton` 骨架，**形状与真实行一致**（列宽、行高相同） | 旋转 spinner |
| **refetch** | **保留上一帧、降低透明度**，不闪骨架 | 每次翻页都闪一次骨架屏（`dataviz` 反模式） |
| **超长 Prompt** | 单行 `truncate` + `title` 全文 + 悬停 `Copy` 按钮（`aria-label="复制 Prompt"`） | 撑破行高 / 撑出横向滚动条 |

**空状态原文（不得改写）**：
- `PG-01`：「还没有评测记录。」+ `去导入评测集` / `去创建待测目标`
- `PG-05`：「没有可导入的有效记录，请检查文件格式。」
- `PG-04`：「本条未提供参考答案」/「暂无基线，仅显示本次输出」

### 6.2 动效预算

全站只允许以下动效，其余一律不加：

| 动效 | 位置 | 时长 / 缓动 | 降级 |
|---|---|---|---|
| Sheet 滑入/滑出 | `PG-04` | 300ms `cubic-bezier(0.32, 0.72, 0, 1)` | `prefers-reduced-motion` → 直接显示 |
| `eval-running` 呼吸脉冲 | 8px 圆点 | 1.6s 无限 | `prefers-reduced-motion` → 静态 |
| hover / focus 过渡 | 通用 | 120ms `ease-out` | — |
| Accordion 展开 | `PG-04` 底部 | 200ms | — |

**明令禁止**：入场 fade-and-slide、滚动视差、渐变描边流动、数字滚动计数（count-up）。数字滚动会让 `tabular-nums` 失去意义并制造读数误差。

### 6.3 焦点与键盘

- `:focus-visible` **永不移除**，统一用 `ring-2 ring-ring ring-offset-2`。
- 所有可点击元素最小 **24×24px**；表格行内操作按钮用图标 + `aria-label`。
- `PG-04` 模态：focus trap、打开聚焦容器、关闭归还焦点。
- `J` / `K` 快捷键在输入控件内**不生效**（§4.3）。
- 全站不设自定义快捷键前缀，只用 `J`/`K` 与 `Esc`。

---

## 7. 反 AI 塑料感硬性禁令与 Linter Gate

### 7.1 三道禁令

| 编号 | 禁令 |
|---|---|
| **AS-1** | **严禁**出现大面积紫粉 / 蓝紫霓虹渐变背景、光晕、玻璃拟态模糊层。 |
| **AS-2** | **严禁**在 `.tsx` / `.jsx` / `.css`（`globals.css` 除外）中硬编码裸 `#hex`、`rgb()`/`hsl()` 字面量或内联 `style={{ color: … }}`。所有颜色必须引用 `DESIGN.md` §2 的语义 Token。 |
| **AS-3** | **严禁**省略三态：任何数据表格必须有真实空状态、Skeleton 骨架、超长文本截断 + 复制。 |

### 7.2 Linter Gate（实现落点，规则正文见 `工程规则.md` §4.1）

```jsonc
// eslint.config.mjs —— 与 shadcn/ui 同级的第三条硬规则组
{
  "no-restricted-syntax": ["error",
    { "selector": "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
      "message": "AS-2：禁止裸写 #hex，请用语义 Token（如 bg-eval-pass-bg）" },
    { "selector": "JSXAttribute[name.name='style']",
      "message": "AS-2：禁止内联样式，颜色与间距一律走 Token / Tailwind 类" },
    { "selector": "Literal[value=/(linear|radial|conic)-gradient/]",
      "message": "AS-1：禁止渐变背景" }
  ]
}
```

配套：

| 项 | 内容 |
|---|---|
| `stylelint` | 对 `components/**/*.css` 启用 `color-no-hex`；`globals.css` 与 `tailwind.config.ts` 白名单豁免 |
| `npm run check:tokens` | 补充扫描 `.tsx` 中的 `rgb(`、`hsl(`、6 位 hex、`gradient(`；CI 必跑 |
| ESLint 依赖边界 | `import/no-restricted-paths` 强制 `app/worker → lib → db → contracts` 单向（`technical-solution.md` §3.7） |
| 禁用导入 | `next/font/google`、任何 CDN 资源 `<link>`、`lucide/dist` 深引 |

---

## 8. 无障碍基线（WCAG 2.2 AA）

| 项 | 要求 |
|---|---|
| 对比度 | 正文 4.5:1，图形与大字号 3:1（§2.5 已逐项实测） |
| 颜色不是唯一编码 | `eval-pass/fail` 必带 `▲/▼` + 正负号；`diff-add/del` 必带 `+/−` 前缀；状态徽章必带图标 + 文案 |
| 焦点 | `:focus-visible` 永不移除；模态 focus trap + 焦点归还 |
| 点击目标 | ≥ 24×24px |
| 动效 | `prefers-reduced-motion: reduce` 必须中和全部动画（含呼吸脉冲与 Sheet 滑入） |
| 实时区域 | `LiveRunProgressBar` 用 `aria-live="polite"`，只播报连接态与 10% 里程碑 |
| 表格 | 真实 `<table>` 语义（`TanStack Table` 渲染 `<table>`/`<th scope>`），不用 `div` 拼网格 |
| 表单 | 每个输入有可见 `<label>`；错误信息用 `aria-describedby` 关联 |

---

## 9. 待核验（不编造，由需求方本地执行）

| # | 项 | 为什么必须跑 | 状态 |
|---|---|---|---|
| V-1 | CVD（色盲）分离度 | 8 个分类色与 4 组状态色的色盲可辨性**不能目测**，必须跑 `validate_palette.js` | ⬜ 校验器被安全分类器拦截，未执行 |
| V-2 | 深色模式全部组合对比度 | 本文件深色值按公式估算，未逐对验证 | ⬜ |
| V-3 | `web-design-guidelines` 最新规则比对 | 该技能要求每次从上游拉取规则清单 | ⬜ `WebFetch` 被拦截 |
| V-4 | `lucide-react` 图标名跨版本改名清单 | `AlertTriangle` → `TriangleAlert` 一类 | ⬜ 写入代码前用 Context7 核验 |
| V-5 | Tailwind v3.4 与 shadcn/ui 当前 `components.json` 的兼容性 | 组件脚手架能否直接落 | ⬜ |

> **在 V-1 / V-2 通过前，不得声称配色"已满足无障碍"**，只能说"文字层对比度已实测，图形与色盲分离度待验证"。

---

## 10. 文案规范

1. **`OPEN-4` 锁死句**：「**EvalRun 可解释，不可复现。**」必须原样出现在 `PG-03` 元数据栏。**不得改写成「可复现」「结果稳定」**。三处落点：`technical-solution.md` §2、`pages-and-flows.md` `PG-03`、本文件 —— 已全部到位。
2. **禁止营销腔**：不写「革命性」「极致」「一键智能」。按钮文案是动词（`发起评测` / `导入评测集` / `查看报告`），不是名词短语。
3. **禁止中点串联与破折号碎句**：不写 `A · B · C`，不写 `WORD — fragment`。
4. **禁止链接尾缀 `→`**：箭头只在 Diff 方向与趋势中使用。
5. **数字不带形容词**：写 `0.9586`，不写「高达 0.9586」。
6. **错误文案必须给出下一步**：`「当前数据集版本没有检索标注，无法计算 Recall@K。请更换版本或移除该算子。」`（`pages-and-flows.md` §5 原文）

---

## 11. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-07 | 建立本文件 | 阶段 03 定稿。五部分：视觉基调与布局 / 色彩语义 Token（浅色 + 深色）/ 字体与 `tabular-nums` 铁律 / 三个评测专用组件 / 反 AI 塑料感禁令与 Linter Gate。附图表规范、交互三态、无障碍基线、文案规范、待核验清单。 |
| 2026-11-07 | **四项拍板落库** | ① `eval-*` 系列拆 `fg`/`bg`/`mark` 三档：需求方选定的 600 级色号全部保留为 `mark`，文字改用 700–800 级（`#059669`→`#047857` 等 4 处），以修复实测不达 WCAG AA 的问题（原值 3.58 / 4.41 / 3.07 / 4.10）。② Tailwind **v3.4** + `tailwind.config.ts`（非 v4 CSS-first）。③ `Inter` + `JetBrains Mono` **本地打包**（`next/font/local` 或 `@fontsource`）。④ **`tabular-nums` 全局强制含指标卡**，理由为 SSE 实时值跳动会导致宽度抖动；此处对 `dataviz` 技能「大号独立数字用比例数字」的建议作**知情偏离**，理由已写入 §3.2。 |
