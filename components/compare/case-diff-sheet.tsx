'use client';

import * as React from 'react';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { MetricDeltaBadge } from '@/components/ui/metric-delta-badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import type { MetricDeltaView } from '@/lib/ui/compare';
import { splitDiffLines, unifiedDiffLines, type DiffRow } from '@/lib/ui/diff.js';
import { formatScore } from '@/lib/format';

/**
 * PG-04 双栏 Diff 抽屉（`DESIGN.md` §4.3 `CaseDiffSheet`，M3 升级版）。
 *
 * M3 形态：输入**同一 Case 在两个 run 下的输出文本**，中段 Tabs 在
 * 并排对比（Split）/ 行内对比（Unified）间切换，行级 diff 由
 * `lib/ui/diff.ts` 的纯函数给出（−/+ 前缀，颜色不作唯一编码）。
 *
 * 键盘（M1 惯例原样保留，`DESIGN.md` §4.3）：
 *  - `J` 下一条 / `K` 上一条，监听**挂在 Sheet 容器**上（callback ref 存 state
 *    ——Portal 内容 open 后才挂载，ref 不触发重渲染会让监听静默挂不上）；
 *  - 焦点在 input / textarea / select / [contenteditable] 内时**一律不拦截**；
 *  - `Esc` 交给 Radix（优先级最高，自带关闭 + 焦点归还触发元素）。
 *
 * 底部 Accordion（检索切片 / 裁判评语）依赖 `CaseDiffRow` 未携带的检索与
 * reason 数据，本批不做（不留空壳假交互）；算子逐算子 Δ 以小表呈现。
 */

/** 行内 diff 行的着色与前缀（颜色不作唯一编码：−/+ 前缀必带）。 */
function DiffLine({ row }: { row: DiffRow }): React.ReactElement {
  const prefix = row.type === 'del' ? '−' : row.type === 'add' ? '+' : ' ';
  return (
    <div
      className={
        row.type === 'del'
          ? 'bg-eval-fail-bg px-2 text-eval-fail num'
          : row.type === 'add'
            ? 'bg-eval-pass-bg px-2 text-eval-pass num'
            : 'px-2 text-body num'
      }
    >
      <span className="select-none" aria-hidden="true">
        {prefix}
      </span>
      {row.text === '' ? ' ' : row.text}
    </div>
  );
}

function EmptyPane({ text }: { text: string }): React.ReactElement {
  return <div className="px-2 py-3 text-xs text-muted-foreground">{text}</div>;
}

export interface CaseDiffSheetRow {
  readonly caseKey: string;
  readonly baselineScore: number | null;
  readonly currentScore: number | null;
  readonly baselineOutputText: string | null;
  readonly currentOutputText: string | null;
  readonly alignmentWarning: string | null;
  readonly operators: ReadonlyArray<{
    readonly evaluatorKey: string;
    readonly baselineScore: number | null;
    readonly currentScore: number | null;
    readonly delta: number | null;
    readonly verdict: string;
  }>;
}

export interface CaseDiffSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 当前抽屉展示的对比行（null = 关闭）。 */
  readonly row: CaseDiffSheetRow | null;
  /** 行在逐条列表中的序号（0 基），用于「第 i / 共 n 条」。 */
  readonly index: number;
  readonly count: number;
  /** `J`（下一条）/ `K`（上一条）导航回调，由父级按逐条列表顺序推进。 */
  readonly onNavigate: (delta: -1 | 1) => void;
  /**
   * 关闭时的焦点归还钩子。Radix 对**无 Trigger 的受控 Dialog** 默认把焦点
   * 归还给 content（实测落到 body）——「归还触发元素」（DESIGN §4.3/§6.3）必须
   * 由调用方在此钩子里手动完成（preventDefault 后自行 focus）。
   */
  readonly onCloseAutoFocus?: (event: Event) => void;
}

export function CaseDiffSheet({
  open,
  onOpenChange,
  row,
  index,
  count,
  onNavigate,
  onCloseAutoFocus,
}: CaseDiffSheetProps): React.ReactElement {
  /**
   * Sheet 容器（M1 惯例）：state 持有 DOM 节点——Radix Portal 内容 open 后才
   * 挂载，ref 不触发重渲染会让监听静默挂不上。
   */
  const [sheetEl, setSheetEl] = React.useState<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (sheetEl === null || !open || row === null) return undefined;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K') return;
      // 组合键不抢：Ctrl+J / Cmd+K 属于浏览器或系统。
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 作用域排除（DESIGN §4.3）：焦点在可输入元素内一律不拦截。
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
      ) {
        return;
      }
      e.preventDefault();
      onNavigate(e.key === 'j' || e.key === 'J' ? 1 : -1);
    };

    sheetEl.addEventListener('keydown', onKeyDown);
    return () => sheetEl.removeEventListener('keydown', onKeyDown);
  }, [sheetEl, open, row, onNavigate]);

  const split = React.useMemo(
    () =>
      row === null
        ? { left: [] as DiffRow[], right: [] as DiffRow[] }
        : splitDiffLines(row.baselineOutputText ?? '', row.currentOutputText ?? ''),
    [row],
  );
  const unified = React.useMemo(
    () => (row === null ? [] : unifiedDiffLines(row.baselineOutputText ?? '', row.currentOutputText ?? '')),
    [row],
  );

  /** 得分对比徽章（任意一侧 null → 无基线 / 不可比，§4.1 口径）。 */
  const scoreView: MetricDeltaView =
    row === null || row.baselineScore === null
      ? { kind: 'text', text: '无基线' }
      : row.currentScore === null
        ? { kind: 'text', text: '不可比' }
        : {
            kind: 'delta',
            variant:
              row.currentScore - row.baselineScore > 0
                ? 'pass'
                : row.currentScore - row.baselineScore < 0
                  ? 'fail'
                  : 'muted',
            arrow:
              row.currentScore > row.baselineScore ? '▲' : row.currentScore < row.baselineScore ? '▼' : null,
            deltaText: `${row.currentScore > row.baselineScore ? '+' : row.currentScore < row.baselineScore ? '−' : ''}${formatScore(Math.abs(row.currentScore - row.baselineScore))}`,
            ariaLabel: `基线 ${formatScore(row.baselineScore)}，当前 ${formatScore(row.currentScore)}`,
          };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={setSheetEl}
        aria-label={row === null ? undefined : `Case ${row.caseKey} 对比详情`}
        onCloseAutoFocus={(e) => {
          if (onCloseAutoFocus === undefined) return;
          e.preventDefault();
          onCloseAutoFocus(e);
        }}
      >
        <SheetHeader>
          <div className="min-w-0 flex-1">
            <SheetTitle className="num text-sm">{row?.caseKey ?? ''}</SheetTitle>
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span className="num">
                第 {index + 1} / {count} 条
              </span>
              {row !== null && row.alignmentWarning !== null ? (
                <span className="text-eval-warn">{row.alignmentWarning}</span>
              ) : null}
            </div>
          </div>
          {row !== null ? (
            <div className="flex items-center gap-1.5">
              <MetricDeltaBadge view={scoreView} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate(-1)}
                title="上一条（K）"
              >
                上一条（K）
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate(1)}
                title="下一条（J）"
              >
                下一条（J）
              </Button>
            </div>
          ) : null}
        </SheetHeader>
        {row !== null ? (
          <Tabs defaultValue="split" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-3 shrink-0" aria-label="Diff 视图切换">
              <TabsTrigger value="split">并排对比</TabsTrigger>
              <TabsTrigger value="unified">行内对比</TabsTrigger>
            </TabsList>
            <SheetBody className="px-4 py-3">
              <TabsContent value="split">
                <div className="grid grid-cols-2 gap-2" data-testid="diff-split">
                  <div>
                    <div className="mb-1 text-2xs text-muted-foreground">基线输出</div>
                    <ScrollArea className="h-[420px] rounded-sm border border-border">
                      {row.baselineOutputText === null ? (
                        <EmptyPane text="暂无基线，仅显示本次输出" />
                      ) : (
                        split.left.map((r, i) => <DiffLine key={i} row={r} />)
                      )}
                    </ScrollArea>
                  </div>
                  <div>
                    <div className="mb-1 text-2xs text-muted-foreground">当前输出</div>
                    <ScrollArea className="h-[420px] rounded-sm border border-border">
                      {row.currentOutputText === null ? (
                        <EmptyPane text="本条当前侧无输出" />
                      ) : (
                        split.right.map((r, i) => <DiffLine key={i} row={r} />)
                      )}
                    </ScrollArea>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="unified">
                <div className="mb-1 text-2xs text-muted-foreground">行内对比（− 基线 / + 当前）</div>
                <ScrollArea className="h-[440px] rounded-sm border border-border" data-testid="diff-unified">
                  {unified.map((r, i) => (
                    <DiffLine key={i} row={r} />
                  ))}
                </ScrollArea>
              </TabsContent>
              {/* 逐算子 Δ（PG-08 行数据的 operators；检索切片 / 裁判评语 Accordion 依赖
                  CaseDiffRow 未携带的数据，本批不做） */}
              <div className="mt-3 rounded-sm border border-border">
                <div className="border-b border-border px-2 py-1.5 text-2xs text-muted-foreground">
                  逐算子 Δ
                </div>
                {row.operators.map((o) => (
                  <div
                    key={o.evaluatorKey}
                    className="flex items-center justify-between px-2 py-1 text-xs"
                  >
                    <span>{o.evaluatorKey}</span>
                    <span className="num text-muted-foreground">
                      {o.baselineScore === null || o.currentScore === null
                        ? '不可比'
                        : `${formatScore(o.baselineScore)} → ${formatScore(o.currentScore)}`}
                    </span>
                    <span className="text-2xs">{o.verdict}</span>
                  </div>
                ))}
              </div>
            </SheetBody>
          </Tabs>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
