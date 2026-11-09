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

  const run = useApi(EvalRunDetail, runId === '' ? null : `/api/runs/${runId}`);
  const cases = useApi(
    EvalCaseResultListResponse,
    runId === ''
      ? null
      : `/api/runs/${runId}/cases?limit=200&sortBy=score&order=${order}`,
  );

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
              setOpenCaseKey(r.caseKey);
            }}
          >
            查看
          </button>
        ),
        srOnlyHeader: '（打开该条 Case 的诊断抽屉）',
      },
    ],
    [],
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
          onRowClick={(r) => setOpenCaseKey(r.caseKey)}
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
          <SheetContent width="default">
            {openCaseKey === null ? null : (
              <CaseInspector runId={runId} caseKey={openCaseKey} />
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
}: {
  runId: string;
  caseKey: string;
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
