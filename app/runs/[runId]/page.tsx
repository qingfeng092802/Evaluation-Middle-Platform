'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import {
  CaseDetailResponse,
  EvalCaseResultListResponse,
  EvalRunDetail,
} from '@eval-platform/contracts';
import type { EvalCaseResult } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { LiveRunProgressBar } from '@/components/runs/live-run-progress-bar';
import { useApi, usePolling } from '@/lib/ui/use-api';
import {
  EMPTY,
  formatCost,
  formatLatency,
  formatScore,
  formatTimestamp,
  formatTokens,
  truncateHash,
} from '@/lib/format';
import { emptyState, type StatusTone } from '@/lib/ui/derive';
import {
  POLL_INTERVAL_MS,
  caseKeyLabel,
  caseStatusLabel,
  caseStatusTone,
  metricCardsOf,
  operatorScoresSummary,
  reproducibilityRows,
  shouldPoll,
} from '@/lib/ui/runs';

/**
 * `PG-03` · 评测运行详情 + `PG-04` 单栏诊断抽屉。
 *
 * 五个区域按 `pages-and-flows.md` 排：
 *  1 元数据栏（含 `OPEN-4` 锁死句「EvalRun 可解释，不可复现。」）；
 *  2 汇总指标卡（`FAILED` ⇒ `coverage` 提主位）；
 *  3 运行中条（`PENDING` 显示「等待调度」）；
 *  4 工具栏（P0 仅按得分排序）；
 *  5 明细表（8 列）+ 行点击开抽屉。
 *
 * 刷新策略见 `lib/ui/runs.ts` 的 `shouldPoll`：终态即停、`document.hidden` 暂停、
 * 回前台立即补拉一次。轮询期间**保留上一帧并降透明度**（`useApi` 的 `refreshing`）。
 */
export default function RunDetailPage(): React.ReactElement {
  const params = useParams<{ runId: string }>();
  const router = useRouter();
  const runId = params?.runId ?? '';

  const [order, setOrder] = React.useState<'asc' | 'desc'>('asc');
  const [openCaseKey, setOpenCaseKey] = React.useState<string | null>(null);

  /**
   * 打开抽屉的那个元素。
   *
   * 抽屉是**受控**的（`open={openCaseKey !== null}`），又没有 `SheetTrigger`
   * ——Radix 关抽屉时只知道「归还给 Trigger」，而 Trigger 不存在，焦点就掉到
   * `<body>` 上：`Esc` 之后键盘用户丢失位置（真浏览器实测暴露）。
   * 把触发元素记下来，在 `onCloseAutoFocus` 里自己还回去。
   */
  const openerRef = React.useRef<HTMLElement | null>(null);

  const openCase = React.useCallback((caseKey: string): void => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setOpenCaseKey(caseKey);
  }, []);

  const run = useApi(EvalRunDetail, runId === '' ? null : `/api/runs/${runId}`);
  const cases = useApi(
    EvalCaseResultListResponse,
    runId === ''
      ? null
      : `/api/runs/${runId}/cases?limit=200&sortBy=score&order=${order}`,
  );

  /**
   * 当前明细表顺序下的 case key 列表（`J`/`K` 的导航依据）。
   *
   * 取的是**表格此刻的渲染顺序**，不是接口返回的原始顺序：用户按了「降序」之后，
   * `J` 的「下一条」必须是视觉上的下一条，否则按一下就跳到表格的另一头。
   */
  const caseKeys = React.useMemo<readonly string[]>(
    () => (cases.data?.items ?? []).map((c) => c.caseKey),
    [cases.data],
  );

  /**
   * 抽屉的 DOM 容器。
   *
   * `J`/`K` 的监听**必须挂在这个容器上**，不能挂 `window`（`DESIGN.md` §4.3）：
   * 挂 `window` 的话，抽屉关掉之后监听还在，用户在别处（甚至别的页面）按 `j`
   * 都会触发一次导航。挂在容器上，抽屉卸载 ⇒ 监听自然消失，不必依赖
   * 「记得在关闭时 removeListener」这种容易漏的写法。
   *
   * 用 **state 而不是 ref** 持有节点：Radix 的 Portal 内容是在 open 之后才挂载的，
   * 用 ref 时 effect 首次运行读到 `null`，而 ref 赋值**不触发重渲染**，
   * effect 就再也不会重跑 —— 监听器永远挂不上，且失败是静默的
   * （按 `J` 没反应，没有任何报错）。改成 callback ref 存进 state，
   * 节点到位时 setState 带来一次重渲染，effect 才会真正绑定。
   */
  const [sheetEl, setSheetEl] = React.useState<HTMLDivElement | null>(null);

  /** 上一条（`K`）/ 下一条（`J`）。循环：到头回绕，与原型 `navigateDrawerCase` 一致。 */
  const stepCase = React.useCallback(
    (delta: -1 | 1): void => {
      if (caseKeys.length === 0) return;
      setOpenCaseKey((current) => {
        if (current === null) return current;
        const at = caseKeys.indexOf(current);
        // 当前 key 不在列表里（理论上不该发生：切换排序后 list 变了，key 还在）
        // ⇒ 从头部开始，而不是静默不动。
        if (at === -1) return caseKeys[delta === 1 ? 0 : caseKeys.length - 1] ?? current;
        const next = (at + delta + caseKeys.length) % caseKeys.length;
        return caseKeys[next] ?? current;
      });
    },
    [caseKeys],
  );

  /**
   * `J` 下一条 / `K` 上一条。`Esc` 交给 Radix 自己处理（它的优先级最高，
   * 在这里拦反而会盖掉 Radix 的「关闭 + 焦点归还」）。
   *
   * **作用域排除**：焦点落在可输入元素里时一律不拦截（`DESIGN.md` §4.3 明确
   * 点名 `input` / `textarea` / `[contenteditable]` / `select`）。否则用户在
   * 筛选框里打字母 `j`、`k` 会被吞掉 —— 这是「快捷键做好事、把输入废掉」的典型。
   * 排除集用 `closest()` 判断，因为焦点可能落在可输入元素内部的子节点上。
   */
  React.useEffect(() => {
    if (sheetEl === null || openCaseKey === null) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K') return;
      // 组合键不抢：`Ctrl+J` / `Cmd+K` 属于浏览器或系统。
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
      ) {
        return;
      }

      e.preventDefault();
      stepCase(e.key === 'j' || e.key === 'J' ? 1 : -1);
    };

    sheetEl.addEventListener('keydown', onKeyDown);
    return () => sheetEl.removeEventListener('keydown', onKeyDown);
  }, [sheetEl, openCaseKey, stepCase]);

  // 只有还在跑的两个状态才轮询；终态之后数据不会再变，继续打接口纯属浪费。
  const live = run.data !== null && shouldPoll(run.data.status, false, true);
  usePolling(
    () => {
      run.reload();
      cases.reload();
    },
    live,
    POLL_INTERVAL_MS,
  );

  const detail = run.data;

  const columns = React.useMemo<readonly DataTableColumn<EvalCaseResult>[]>(
    () => [
      {
        id: 'caseKey',
        header: 'Case Key',
        cell: (r) => (
          <span className="num-mono text-xs" title={r.caseKey}>
            {caseKeyLabel(r.caseKey)}
          </span>
        ),
      },
      {
        id: 'query',
        header: 'Query 摘要',
        cell: (r) => (
          <span className="block max-w-[26ch] truncate text-body" title={r.querySummary}>
            {r.querySummary}
          </span>
        ),
      },
      {
        id: 'score',
        header: '得分',
        numeric: true,
        // `null` ⇒ —（`status !== 'OK'` 时数据库强制 score 为 NULL，渲染 0 就是造假）
        cell: (r) => formatScore(r.score),
      },
      {
        id: 'operators',
        header: '各算子得分',
        cell: (r) => (
          <span className="num-mono block max-w-[30ch] truncate text-2xs text-muted-foreground">
            {operatorScoresSummary(
              r.operatorScores === null
                ? null
                : r.operatorScores.map((o) => ({ key: o.key, score: o.score })),
            )}
          </span>
        ),
      },
      {
        id: 'latency',
        header: '耗时',
        numeric: true,
        cell: (r) => formatLatency(r.latencyMs),
      },
      {
        id: 'tokens',
        header: 'Token',
        numeric: true,
        cell: (r) => formatTokens(r.tokensIn + r.tokensOut),
      },
      {
        id: 'status',
        header: '状态',
        cell: (r) => <CaseStatusBadge status={r.status} />,
      },
      {
        id: 'actions',
        header: '操作',
        cell: (r) => (
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              openCase(r.caseKey);
            }}
          >
            查看
          </button>
        ),
        srOnlyHeader: '（打开该条 Case 的诊断抽屉）',
      },
    ],
    [openCase],
  );

  if (run.loading) {
    return (
      <AppShellWithTheme breadcrumbs={breadcrumbs(runId)}>
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
          <p className="text-xs text-muted-foreground">加载中…</p>
        </div>
      </AppShellWithTheme>
    );
  }

  if (detail === null) {
    return (
      <AppShellWithTheme breadcrumbs={breadcrumbs(runId)}>
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            {run.error === null ? '评测运行不存在。' : `加载失败：${run.error.message}`}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => router.push('/runs')}>
            返回评测运行
          </Button>
        </div>
      </AppShellWithTheme>
    );
  }

  const cards = metricCardsOf(detail);
  const completed = detail.counts.succeededCases + detail.counts.failedCases;

  return (
    <AppShellWithTheme breadcrumbs={breadcrumbs(runId)}>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        {/* ---- 区域 1 · 元数据栏 ---- */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-base font-semibold text-foreground">{detail.name}</h1>
            <StatusBadge status={detail.status} />
          </div>

          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <MetaItem label="评测集">{detail.datasetLabel}</MetaItem>
            <MetaItem label="待测目标">{detail.targetLabel}</MetaItem>
            <MetaItem label="算子数">{String(detail.evaluators.length)}</MetaItem>
            <MetaItem label="并发">{String(detail.concurrency)}</MetaItem>
            <MetaItem label="发起人">{detail.createdBy}</MetaItem>
            <MetaItem label="开始时间">
              <span className="num-mono">{formatTimestamp(detail.startedAt)}</span>
            </MetaItem>
            <MetaItem label="结束时间">
              <span className="num-mono">{formatTimestamp(detail.finishedAt)}</span>
            </MetaItem>
          </dl>

          <ReproducibilityNote detail={detail} />
        </div>

        {/* ---- 区域 2 · 汇总指标卡 ---- */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((card) => (
            <div
              key={card.key}
              className={[
                'flex flex-col gap-1 rounded-md border border-border px-3 py-2',
                card.primary ? 'bg-muted/40' : 'bg-card',
              ].join(' ')}
            >
              <span className="text-2xs text-muted-foreground">{card.label}</span>
              <span
                className={[
                  'num font-semibold text-foreground',
                  card.primary ? 'text-base' : 'text-sm',
                ].join(' ')}
              >
                {card.value}
              </span>
            </div>
          ))}
        </div>

        {/* ---- 区域 3 · 运行中条 ---- */}
        {detail.status === 'PENDING' || detail.status === 'RUNNING' ? (
          <Card>
            <CardContent className="pt-3">
              <LiveRunProgressBar
                completedCount={completed}
                totalCount={detail.counts.totalCases}
                failedCount={detail.counts.failedCases}
                runStatus={detail.status}
                live={live}
                score={null}
                passed={null}
                latencyMs={null}
              />
            </CardContent>
          </Card>
        ) : null}

        {/* ---- 区域 4 · 工具栏（P0 仅按得分排序） ---- */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">按得分</span>
          <Button
            type="button"
            size="sm"
            variant={order === 'asc' ? 'secondary' : 'outline'}
            onClick={() => setOrder('asc')}
            aria-pressed={order === 'asc'}
          >
            升序
          </Button>
          <Button
            type="button"
            size="sm"
            variant={order === 'desc' ? 'secondary' : 'outline'}
            onClick={() => setOrder('desc')}
            aria-pressed={order === 'desc'}
          >
            降序
          </Button>
          <span className="num text-2xs text-muted-foreground">
            共 {detail.counts.totalCases} 条 · 成功 {detail.counts.succeededCases} ·
            失败 {detail.counts.failedCases}
          </span>
        </div>

        {/* ---- 区域 5 · 明细表 ---- */}
        {cases.error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            明细加载失败：{cases.error.message}
          </div>
        ) : null}

        <DataTable<EvalCaseResult>
          columns={columns}
          rows={cases.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={cases.loading}
          refreshing={cases.refreshing}
          onRowClick={(r) => openCase(r.caseKey)}
          rowAriaLabel={(r) => `Case ${r.caseKey}，状态${caseStatusLabel(r.status)}`}
        />

        {/* ---- PG-04 抽屉 ---- */}
        <Sheet
          open={openCaseKey !== null}
          onOpenChange={(next) => {
            // 关闭时清空 key：抽屉状态不写 URL，刷新即关闭（`PG-04` 的原文要求）。
            if (!next) setOpenCaseKey(null);
          }}
        >
          <SheetContent
            ref={setSheetEl}
            width="default"
            // 受控且无 Trigger ⇒ 自己把焦点还给打开抽屉的那个元素。
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              openerRef.current?.focus();
            }}
          >
            {openCaseKey === null ? null : (
              <CaseInspector
                runId={runId}
                caseKey={openCaseKey}
                // 只有一条时上/下一条按钮没有意义（点哪都是自己）。
                onPrev={caseKeys.length > 1 ? () => stepCase(-1) : null}
                onNext={caseKeys.length > 1 ? () => stepCase(1) : null}
              />
            )}
          </SheetContent>
        </Sheet>
      </div>
    </AppShellWithTheme>
  );
}

function breadcrumbs(runId: string): readonly { label: string; href?: string }[] {
  return [
    { label: '评测运行', href: '/runs' },
    { label: runId === '' ? '运行详情' : truncateHash(runId), href: `/runs/${runId}` },
  ];
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

/**
 * `OPEN-4` 锁死句 + 可展开的可复现性字段表。
 *
 * 用原生 `<details>` 而不是自建折叠：它自带键盘展开与 `aria-expanded`，
 * 而且**不需要 JS**——这句话即便脚本挂了也应该看得见。
 */
function ReproducibilityNote({
  detail,
}: {
  detail: {
    reproducibility: Parameters<typeof reproducibilityRows>[0];
    runnerVersion: string;
  };
}): React.ReactElement {
  const rows = reproducibilityRows(detail.reproducibility);

  return (
    <details className="group rounded-md border border-border bg-card px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-foreground">
        <ChevronRight
          className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {/* 原文，不得改写。改成「可复现」就是对用户的谎言。 */}
        <span className="font-medium">{emptyState('reproducibilityNotice').message}</span>
        <span className="text-2xs text-muted-foreground">展开看快照字段</span>
      </summary>

      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border pt-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-2xs text-muted-foreground">{row.label}</dt>
            <dd
              className={[
                'text-2xs text-foreground',
                row.mono ? 'num-mono' : '',
              ].join(' ').trim()}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const TONE_VARIANT: Readonly<Record<StatusTone, 'muted' | 'running' | 'pass' | 'warn' | 'fail'>> = {
  muted: 'muted',
  running: 'running',
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
};

function CaseStatusBadge({
  status,
}: {
  status: EvalCaseResult['status'];
}): React.ReactElement {
  return <Badge variant={TONE_VARIANT[caseStatusTone(status)]}>{caseStatusLabel(status)}</Badge>;
}

/**
 * `PG-04` · 单条 Case 诊断（五个区块）。
 *
 * `PG-04` 只允许单栏：M1 无已确认基线的双栏 Diff，区块 3 固定标注
 * 「暂无基线，仅显示本次输出」——而不是悄悄多画一列。
 * 抽屉里**只有「关闭」**：无「人工改判」「提交修正」「加入回流」。
 */
function CaseInspector({
  runId,
  caseKey,
  onPrev,
  onNext,
}: {
  runId: string;
  caseKey: string;
  /** `null` ⇒ 只有一条 case，不给可点而无反应的按钮。 */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}): React.ReactElement {
  const detail = useApi(
    CaseDetailResponse,
    `/api/runs/${runId}/cases/${encodeURIComponent(caseKey)}`,
  );
  const data = detail.data;

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <span className="num-mono text-sm" title={caseKey}>
            {caseKeyLabel(caseKey)}
          </span>
        </SheetTitle>
        <SheetDescription>
          单条 Case 全貌。本页只读：无改判、无回流。
        </SheetDescription>

        {/*
          `DESIGN.md` §4.3 固定头：上一条 / 下一条 + 关闭。
          - 按钮的 `title` 里写明快捷键，用户不必先知道 `J`/`K` 才能发现它们；
          - 快捷键本身由 `SheetContent` 容器上的 `keydown` 监听处理（不是 `window`）；
          - 只有一条 case 时 `onPrev`/`onNext` 为 `null`，按钮不渲染 ——
            「点了没反应」比「没有按钮」更糟。
        */}
        {onPrev === null && onNext === null ? null : (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPrev ?? undefined}
              disabled={onPrev === null}
              title="上一条 (快捷键 K)"
              data-case-nav="prev"
            >
              上一条
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onNext ?? undefined}
              disabled={onNext === null}
              title="下一条 (快捷键 J)"
              data-case-nav="next"
            >
              下一条
            </Button>
          </div>
        )}
      </SheetHeader>

      <SheetBody className="flex flex-col gap-5">
        {detail.loading ? <p className="text-xs text-muted-foreground">加载中…</p> : null}
        {detail.error !== null ? (
          <p className="text-xs text-eval-fail">加载失败：{detail.error.message}</p>
        ) : null}

        {data === null ? null : (
          <>
            {/* 区块 1 · 输入 */}
            <Section title="1 · 输入">
              <Labeled label="Query">
                <p className="whitespace-pre-wrap text-xs text-foreground">
                  {String(data.datasetCase.input['query'] ?? '')}
                </p>
              </Labeled>
              {Object.entries(data.datasetCase.input)
                .filter(([k]) => k !== 'query')
                .map(([k, v]) => (
                  <Labeled key={k} label={k}>
                    <p className="whitespace-pre-wrap text-xs text-foreground">
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </p>
                  </Labeled>
                ))}
            </Section>

            {/* 区块 2 · 标准参考答案 */}
            <Section title="2 · 标准参考答案">
              {data.datasetCase.reference?.golden_answer === undefined ||
              data.datasetCase.reference.golden_answer === '' ? (
                <p className="text-xs text-muted-foreground">
                  {emptyState('noReference').message}
                </p>
              ) : (
                <p className="whitespace-pre-wrap text-xs text-foreground">
                  {data.datasetCase.reference.golden_answer}
                </p>
              )}
            </Section>

            {/* 区块 3 · 输出（P0 单栏） */}
            <Section title="3 · 输出">
              <p className="text-2xs text-muted-foreground">{emptyState('noBaseline').message}</p>
              {data.result.outputText === null ? (
                <p className="text-xs text-muted-foreground">{EMPTY}</p>
              ) : (
                <p className="whitespace-pre-wrap text-xs text-foreground">
                  {data.result.outputText}
                </p>
              )}
              {data.result.errorMessage === null ? null : (
                <p className="text-2xs text-eval-fail">{data.result.errorMessage}</p>
              )}
            </Section>

            {/* 区块 4 · 检索上下文 */}
            <Section title="4 · 检索上下文">
              {data.datasetCase.retrieval === null ? (
                <p className="text-xs text-muted-foreground">本条没有检索标注。</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.datasetCase.retrieval.relevant.map((d) => (
                    <li key={d.doc_id} className="flex items-baseline gap-2 text-xs">
                      <span className="num-mono text-foreground">{d.doc_id}</span>
                      <span className="num text-2xs text-muted-foreground">grade {d.grade}</span>
                    </li>
                  ))}
                </ul>
              )}
              {data.result.retrievalReturned === null ? null : (
                <details className="mt-1">
                  <summary className="cursor-pointer text-2xs text-muted-foreground">
                    本次实际召回（原始 JSON）
                  </summary>
                  <pre className="mt-1 max-h-[200px] overflow-auto rounded-sm bg-muted px-2 py-1 text-2xs">
                    {JSON.stringify(data.result.retrievalReturned, null, 2)}
                  </pre>
                </details>
              )}
            </Section>

            {/* 区块 5 · 打分明细 */}
            <Section title="5 · 打分明细">
              {data.result.operatorScores === null ||
              data.result.operatorScores.length === 0 ? (
                <p className="text-xs text-muted-foreground">本条没有算子得分。</p>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border text-2xs text-muted-foreground">
                      <th scope="col" className="py-1 text-left font-medium">
                        算子
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        得分
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        阈值
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        通过
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.result.operatorScores.map((o) => (
                      <tr key={o.key} className="border-b border-border last:border-0">
                        <td className="num-mono py-1 text-foreground">{o.key}</td>
                        <td className="num py-1 text-right">{formatScore(o.score)}</td>
                        <td className="num py-1 text-right">{formatScore(o.threshold)}</td>
                        <td className="py-1 text-right">
                          {/* 无阈值 ⇒ 该算子不参与 AND 判定，显示「不判定」而不是「否」 */}
                          {o.passed === null ? (
                            <span className="text-2xs text-muted-foreground">不判定</span>
                          ) : o.passed ? (
                            <span className="text-eval-pass">是</span>
                          ) : (
                            <span className="text-eval-fail">否</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {data.result.operatorScores?.map((o) =>
                o.reason === null ? null : (
                  <div key={`${o.key}-reason`} className="flex flex-col gap-0.5">
                    <span className="num-mono text-2xs text-muted-foreground">{o.key}</span>
                    <p className="whitespace-pre-wrap text-2xs text-foreground">{o.reason}</p>
                  </div>
                ),
              )}

              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-2xs text-muted-foreground">
                <span>
                  本 Case 成本{' '}
                  {/* `costTotal` 是数据库的 STORED 生成列，**只读**；这里绝不做 target + judge 相加 */}
                  <span className="num text-foreground">
                    {formatCost(data.result.costTotal, 'case')}
                  </span>
                </span>
                <span>
                  耗时{' '}
                  <span className="num text-foreground">
                    {formatLatency(data.result.latencyMs)}
                  </span>
                </span>
                <span>
                  Token{' '}
                  <span className="num text-foreground">
                    {formatTokens(data.result.tokensIn + data.result.tokensOut)}
                  </span>
                </span>
              </div>
            </Section>
          </>
        )}
      </SheetBody>

      {/* PG-04：抽屉里只有「关闭」 */}
      <div className="shrink-0 border-t border-border px-4 py-2">
        <SheetClose asChild>
          <Button type="button" variant="outline" size="sm">
            关闭
          </Button>
        </SheetClose>
      </div>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="num-mono text-2xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
