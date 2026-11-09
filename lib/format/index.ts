/**
 * 数字与标识符格式化（`DESIGN.md` §3.3「数字格式表」的唯一实现）。
 *
 * 为什么集中在一处而不是各组件各写一份 `toFixed`：
 * `tabular-nums` 只能保证「同一字宽的字符等宽」，**不保证小数点对齐**。
 * 对齐的前提是**每个指标的小数位数完全一致**。一旦某处写成 `0.995` 而别处 `0.9952`，
 * 等宽也救不回列对齐。所以这里对每个指标固定位数，组件只调函数、不碰 `toFixed`。
 *
 * 全局约定：
 *  - `null` **一律**渲染为 `—`（U+2014）。缺失 ≠ 0：`FAILED` 运行的 `score_overall`
 *    与「无 `passThreshold` 的 `pass_rate`」都是 `NULL`，渲染成 `0` 就是制造假数据。
 *  - 不使用 `Intl.NumberFormat` 的语言环境默认值：它在不同 Node / 浏览器下分组符可能
 *    是 `,` 或窄空格。数据工具里读数的一致性优先，故显式分组。
 */

/** 缺失值占位符。全站唯一，禁止各处自造 `-` / `N/A` / `null`。 */
export const EMPTY = '—';

const THIN_SPACE = /\B(?=(\d{3})+(?!\d))/g;

/** 千分位分组（只处理非负整数部分；负数由调用方先取绝对值的符号）。 */
function groupDigits(intPart: string): string {
  return intPart.replace(THIN_SPACE, ',');
}

/** 把数值拆成「符号 + 整数部分 + 小数部分」，四舍五入到 `digits` 位。 */
function splitFixed(value: number, digits: number): {
  sign: string;
  int: string;
  frac: string;
} {
  const negative = value < 0;
  // `Math.abs` 后再 `toFixed`：避免 `(-0.00004).toFixed(4)` 得到 `-0.0000`
  const abs = Math.abs(value);
  const fixed = abs.toFixed(digits);
  const dot = fixed.indexOf('.');
  const int = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot + 1);
  return { sign: negative && Number(fixed) !== 0 ? '-' : '', int, frac };
}

// ---------------------------------------------------------------------------
// 分数 / 比率
// ---------------------------------------------------------------------------

/** 综合得分 / 算子得分：固定 4 位小数。`null` ⇒ `—`。 */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const { sign, int, frac } = splitFixed(value, 4);
  return `${sign}${int}.${frac}`;
}

/**
 * 分数空间的差值：带符号 4 位小数 + 方向箭头。
 *
 * 方向**同时**用符号与箭头编码（WCAG 1.4.1：颜色不得是唯一编码）。
 * 零变化不加箭头 —— `+0.0000 ▲` 会被读成「有提升」。
 */
export function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const text = formatScore(value);
  const zero = text === '0.0000';
  if (zero) return text;
  if (value > 0) return `+${text} ▲`;
  return `${text} ▼`;
}

/** 通过率 / 覆盖率：固定 2 位 + `%`，**不省尾零**。`null` ⇒ `—`。 */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const { sign, int, frac } = splitFixed(value * 100, 2);
  return `${sign}${int}.${frac}%`;
}

/** 百分比空间的差值：带符号 2 位 + `%`。零变化不带符号（与 `formatDelta` 一致）。 */
export function formatDeltaPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const { sign, int, frac } = splitFixed(value * 100, 2);
  const body = `${int}.${frac}%`;
  if (sign === '-') return `-${body}`;
  // `splitFixed` 已把 `-0.0001` 这类四舍五入后归零的负数收敛成无符号，这里同样不加 `+`
  return Number(int) === 0 && Number(frac) === 0 ? body : `+${body}`;
}

// ---------------------------------------------------------------------------
// 量值与资源
// ---------------------------------------------------------------------------

/** 延迟：整数 + 千分位 + `ms`。`null` ⇒ `—`。 */
export function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  return `${formatInteger(value)} ms`;
}

/** Token：整数 + 千分位（无单位后缀，列头已写明）。`null` ⇒ `—`。 */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  return formatInteger(value);
}

function formatInteger(value: number): string {
  const negative = value < 0;
  const abs = Math.round(Math.abs(value));
  const text = groupDigits(String(abs));
  return negative && abs !== 0 ? `-${text}` : text;
}

/** 成本单位：`case` = 单条 4 位；`total` = 汇总 2 位。 */
export type CostPrecision = 'case' | 'total';

/** 成本（USD）：单条 4 位 / 汇总 2 位。`null` ⇒ `—`。 */
export function formatCost(value: number | null | undefined, precision: CostPrecision): string {
  if (value === null || value === undefined) return EMPTY;
  const digits = precision === 'case' ? 4 : 2;
  const { sign, int, frac } = splitFixed(value, digits);
  return `${sign}$${int}.${frac}`;
}

// ---------------------------------------------------------------------------
// 时间与标识符
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 时间戳：`YYYY-MM-DD HH:mm:ss`，**本地时区**。
 *
 * 用本地时区而非 UTC：排查时用户对照的是自己看到的时钟。
 * 契约里的 `IsoDateTime` 仍统一 UTC，只在渲染层折算。
 */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * Hash / Trace ID：超过 12 位则取「前 8 + `…` + 后 4」。
 *
 * 恰好 12 位不省略 —— 省略没有任何收益却多一次复制失真的机会。
 */
export function truncateHash(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
