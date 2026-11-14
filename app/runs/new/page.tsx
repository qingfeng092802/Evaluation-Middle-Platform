'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  DatasetListResponse,
  DatasetVersionListResponse,
  EvalRunDetail,
  ModelProviderListResponse,
  RunPreflight,
  TargetListResponse,
} from '@eval-platform/contracts';
import type {
  ModelProvider,
  RunPreflight as RunPreflightType,
  Target,
} from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { formatTimestamp, truncateHash } from '@/lib/format';
import { blockerText } from '@/lib/ui/derive';
import { needsRetrieval } from '@/lib/preflight';
import { modelCell, promptSummary, targetKindLabel } from '@/lib/ui/targets';
import {
  JUDGE_OPERATOR_SPEC,
  RULE_OPERATOR_SPECS,
  buildRunEvaluators,
  defaultConfigOf,
  defaultJudgeDraft,
  judgeConfigError,
  judgeScaleThresholdToNormalized,
  judgeWarnings,
  operatorConfigError,
  type JudgeDraft,
  type RuleField,
  type SelectedEvaluator,
} from '@/lib/ui/wizard';
import { versionCell } from '@/lib/ui/datasets';

/**
 * `PG-02` · 发起评测向导（整页 4 步）。
 *
 * 数据全部来自真实接口：`/api/datasets*`、`/api/targets*`、`/api/providers`、
 * `/api/runs/preflight`、`POST /api/runs`。**没有一行写死的 Case / Target / 评测结果**。
 *
 * 第 3 步渲染两块：六个「确定性规则算子」（M1）+「LLM 裁判算子」（M2 · Batch 2）。
 * 裁判单独一块而不是混进规则算子清单，理由见 `lib/ui/wizard.ts` 文件头。
 *
 * 三条阻塞校验**不在本页重新实现**：页面把已选算子传给
 * `GET /api/runs/preflight`，由 `lib/preflight/index.ts`（服务端 `POST /api/runs`
 * 用的同一份代码）给出 `blockers`，文案经 `blockerText()` 取 `pages-and-flows.md` §5 原文。
 */
export default function NewRunPage(): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = React.useState(0);

  // ---- 选择状态 ----
  const [datasetVersionId, setDatasetVersionId] = React.useState<string | null>(null);
  const [targetVersionId, setTargetVersionId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<readonly SelectedEvaluator[]>([]);
  /** `null` = 本次运行不含裁判算子。 */
  const [judge, setJudge] = React.useState<JudgeDraft | null>(null);
  const [name, setName] = React.useState('');
  const [concurrency, setConcurrency] = React.useState('4');

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const providers = useApi(ModelProviderListResponse, '/api/providers');

  const evaluators = React.useMemo(
    () => buildRunEvaluators({ judge, rules: selected }),
    [judge, selected],
  );

  // preflight 要知道**全部**算子 key（含 judge）—— 只传规则算子会让「选了裁判」
  // 在后端不可见，于是 `hasEvaluators` 恒为 false 的假象不会出现，但用户也得不到
  // 「裁判厂商不可用」这类提示。这里用最终要提交的同一份数组。
  const keysParam =
    evaluators.length === 0 ? null : evaluators.map((e) => e.config.key).join(',');
  const preflight = useApi(
    RunPreflight,
    datasetVersionId === null
      ? null
      : `/api/runs/preflight?datasetVersionId=${datasetVersionId}${keysParam === null ? '' : `&evaluatorKeys=${keysParam}`}`,
  );

  const judgeReady = judge === null || judgeConfigError(judge) === null;

  const perStepReady = [
    datasetVersionId !== null,
    targetVersionId !== null,
    evaluators.length > 0 &&
      selected.every((s) => operatorConfigError(s) === null) &&
      judgeReady,
    name.trim() !== '' &&
      Number(concurrency) >= 1 &&
      preflight.data?.canStart === true,
  ] as const;

  const canNext = perStepReady[step] === true;

  async function onStart(): Promise<void> {
    if (datasetVersionId === null || targetVersionId === null) return;
    setBusy(true);
    setError(null);
    try {
      const run = await apiPost(EvalRunDetail, '/api/runs', {
        name: name.trim(),
        datasetVersionId,
        targetVersionId,
        concurrency: Number(concurrency),
        evaluators,
      });
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动失败');
      setBusy(false);
    }
  }

  return (
    <AppShellWithTheme
      breadcrumbs={[
        { label: '评测运行', href: '/runs' },
        { label: '发起评测', href: '/runs/new' },
      ]}
    >
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">发起评测</h1>

        {/* 步骤指示：编号 + 标题，当前步高亮 */}
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {['选择评测集版本', '选择待测目标', '配置评测算子', '确认并发与运行'].map((title, i) => (
            <li key={title} className="flex items-center gap-2">
              <span
                className={[
                  'num inline-flex h-5 w-5 items-center justify-center rounded-full border',
                  i === step
                    ? 'border-primary bg-primary text-primary-foreground'
                    : perStepReady[i] === true
                      ? 'border-eval-pass text-eval-pass'
                      : 'border-border text-muted-foreground',
                ].join(' ')}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <span className={i === step ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                {title}
              </span>
              {i < 3 ? (
                <span className="text-muted-foreground" aria-hidden="true">
                  /
                </span>
              ) : null}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <StepDataset selectedId={datasetVersionId} onSelect={setDatasetVersionId} />
        ) : null}
        {step === 1 ? (
          <StepTarget selectedId={targetVersionId} onSelect={setTargetVersionId} />
        ) : null}
        {step === 2 ? (
          <StepEvaluators
            selected={selected}
            onChange={setSelected}
            judge={judge}
            onJudgeChange={setJudge}
            providers={providers.data?.items ?? []}
            retrievalReadiness={preflight.data?.retrievalReadiness ?? null}
          />
        ) : null}
        {step === 3 ? (
          <StepConfirm
            name={name}
            onNameChange={setName}
            concurrency={concurrency}
            onConcurrencyChange={setConcurrency}
            preflight={preflight.data}
            preflightError={preflight.error?.message ?? null}
            evaluatorCount={selected.length}
          />
        ) : null}

        {error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={step === 0 || busy}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            上一步
          </Button>
          {step < 3 ? (
            <Button
              type="button"
              size="sm"
              disabled={!canNext}
              onClick={() => setStep((s) => Math.min(3, s + 1))}
            >
              下一步
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!canNext || busy} onClick={() => void onStart()}>
              启动评测
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              // 二次确认的文案按 §5 原文：「放弃本次配置？」
              if (window.confirm('放弃本次配置？')) router.push('/runs');
            }}
          >
            取消
          </Button>
          {busy ? <span className="text-xs text-muted-foreground">提交中…</span> : null}
        </div>
      </div>
    </AppShellWithTheme>
  );
}

// ---------------------------------------------------------------------------
// 步骤 1 · 选择评测集版本
// ---------------------------------------------------------------------------

function StepDataset({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (versionId: string) => void;
}): React.ReactElement {
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [datasetId, setDatasetId] = React.useState<string>('');
  const effectiveId = datasetId !== '' ? datasetId : (datasets.data?.items[0]?.id ?? '');
  const versions = useApi(
    DatasetVersionListResponse,
    effectiveId === '' ? null : `/api/datasets/${effectiveId}/versions`,
  );

  const items = versions.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>1 · 选择评测集版本</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex min-w-[220px] max-w-[360px] flex-col gap-1">
          <Label htmlFor="wizard-dataset">评测集</Label>
          <Select id="wizard-dataset" value={effectiveId} onChange={(e) => setDatasetId(e.target.value)}>
            {datasets.data?.items.length === 0 ? <option value="">（还没有评测集）</option> : null}
            {datasets.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          {datasets.error !== null ? (
            <p className="text-2xs text-eval-fail">加载失败：{datasets.error.message}</p>
          ) : null}
        </div>

        {versions.loading ? <p className="text-xs text-muted-foreground">加载版本…</p> : null}
        {versions.error !== null ? (
          <p className="text-xs text-eval-fail">加载失败：{versions.error.message}</p>
        ) : null}
        {versions.data !== null && items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            该评测集还没有版本。请先到「评测集」导入数据。
          </p>
        ) : null}

        {items.length === 0 ? null : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">版本</legend>
            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {items.map((v) => (
                <label
                  key={v.id}
                  className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs hover:bg-muted"
                >
                  <input
                    type="radio"
                    name="wizard-dataset-version"
                    value={v.id}
                    checked={selectedId === v.id}
                    onChange={() => onSelect(v.id)}
                  />
                  <span className="num font-medium text-foreground">{versionCell(v.versionNo)}</span>
                  <span className="num text-muted-foreground">{v.caseCount} 条</span>
                  <span className="num-mono text-muted-foreground" title={v.contentHash}>
                    {truncateHash(v.contentHash)}
                  </span>
                  <span className="num-mono text-muted-foreground">{formatTimestamp(v.createdAt)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 步骤 2 · 选择待测目标
// ---------------------------------------------------------------------------

function StepTarget({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (targetVersionId: string) => void;
}): React.ReactElement {
  const targets = useApi(TargetListResponse, '/api/targets?limit=50');
  const items = (targets.data?.items ?? []).filter((t) => t.currentVersion !== null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>2 · 选择待测目标</CardTitle>
        <Button asChild variant="outline" size="sm">
          <a href="/targets">+ 新建待测目标</a>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {targets.loading ? <p className="text-xs text-muted-foreground">加载中…</p> : null}
        {targets.error !== null ? (
          <p className="text-xs text-eval-fail">加载失败：{targets.error.message}</p>
        ) : null}
        {targets.data !== null && items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有可用的待测目标。请先到「待测目标」创建一个 T1 目标。
          </p>
        ) : null}

        {items.length === 0 ? null : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">目标</legend>
            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {items.map((t) => (
                <TargetOption
                  key={t.id}
                  target={t}
                  checked={selectedId === t.currentVersion?.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}

function TargetOption({
  target,
  checked,
  onSelect,
}: {
  target: Target;
  checked: boolean;
  onSelect: (versionId: string) => void;
}): React.ReactElement | null {
  // 上面已 filter 掉 `currentVersion === null`，这里再判一次是给类型收窄用，
  // 顺带保证「点不动又没有版本的幽灵行」不会因为 filter 被谁删掉而回来。
  const version = target.currentVersion;
  if (version === null) return null;

  return (
    <label className="flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-xs hover:bg-muted">
      <span className="flex flex-wrap items-center gap-x-3">
        <input
          type="radio"
          name="wizard-target"
          value={version.id}
          checked={checked}
          onChange={() => onSelect(version.id)}
        />
        <span className="font-medium text-foreground">{target.name}</span>
        <span className="num text-muted-foreground">v{version.versionNo}</span>
        <span className="text-muted-foreground">{targetKindLabel(target.kind)}</span>
        <span className="num-mono text-muted-foreground">{modelCell(target)}</span>
      </span>
      <span className="truncate pl-6 text-muted-foreground">{promptSummary(version)}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// 步骤 3 · 配置评测算子（规则算子 + LLM 裁判算子）
// ---------------------------------------------------------------------------

function StepEvaluators({
  selected,
  onChange,
  judge,
  onJudgeChange,
  providers,
  retrievalReadiness,
}: {
  selected: readonly SelectedEvaluator[];
  onChange: (next: readonly SelectedEvaluator[]) => void;
  judge: JudgeDraft | null;
  onJudgeChange: (next: JudgeDraft | null) => void;
  providers: readonly ModelProvider[];
  retrievalReadiness: RunPreflightType['retrievalReadiness'] | null;
}): React.ReactElement {
  // 「有没有勾检索类算子」不在这里重写一遍：`needsRetrieval` 是 `lib/preflight` 的
  // 唯一实现，服务端 `POST /api/runs` 与 `GET /api/runs/preflight` 用的也是它。
  const retrievalBlocked =
    needsRetrieval(selected.map((s) => s.key)) &&
    retrievalReadiness !== null &&
    retrievalReadiness.state !== 'ALL';

  function toggle(key: SelectedEvaluator['key']): void {
    const exists = selected.find((s) => s.key === key);
    if (exists) {
      onChange(selected.filter((s) => s.key !== key));
      return;
    }
    onChange([
      ...selected,
      { key, config: defaultConfigOf(key), weight: 1, passThreshold: null },
    ]);
  }

  function patch(key: string, next: Partial<SelectedEvaluator>): void {
    onChange(selected.map((s) => (s.key === key ? { ...s, ...next } : s)));
  }

  const totalCount = selected.length + (judge === null ? 0 : 1);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>3 · 配置评测算子</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            确定性规则算子，参数确定、结果可复现。检索类算子需要该版本有完整检索标注。
          </p>

          {/*
            只在**真的勾了检索类算子**、且该版本不是全量标注时才提示。
            无条件显示会让「一个检索算子都没选」的用户看到一句与本次配置无关的告警。
            文案走 `blockerText()`，即 `pages-and-flows.md` §5 的原文。
          */}
          {retrievalBlocked && retrievalReadiness !== null ? (
            <div className="rounded-md border border-eval-warn bg-eval-warn-bg px-3 py-2 text-xs text-eval-warn">
              {blockerText('BLOCKED_NO_RETRIEVAL_ANNOTATION').message}
              <span className="num ml-1">
                （{retrievalReadiness.annotatedCount} / {retrievalReadiness.totalCount} 条已标注）
              </span>
            </div>
          ) : null}

          <div className="flex flex-col divide-y divide-border rounded-md border border-border">
            {RULE_OPERATOR_SPECS.map((spec) => {
              const sel = selected.find((s) => s.key === spec.key);
              return (
                <div key={spec.key} className="flex flex-col gap-2 px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={sel !== undefined}
                      onChange={() => toggle(spec.key)}
                    />
                    <span className="font-medium text-foreground">{spec.label}</span>
                    <span className="text-muted-foreground">{spec.hint}</span>
                  </label>
                  {sel === undefined ? null : (
                    <EvaluatorParams spec={spec} selected={sel} onPatch={(p) => patch(spec.key, p)} />
                  )}
                </div>
              );
            })}
          </div>

          {totalCount === 0 ? (
            <p className="text-xs text-eval-fail">{blockerText('BLOCKED_NO_EVALUATORS').message}</p>
          ) : null}
        </CardContent>
      </Card>

      <JudgeBlock judge={judge} onChange={onJudgeChange} providers={providers} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤 3 的第二块 · LLM 裁判算子（M2 · Batch 2 · 交付物 3）
// ---------------------------------------------------------------------------

/**
 * 「LLM 裁判算子」配置区块。
 *
 * 字段与 `JUDGE_OPERATOR_SPEC.fields` 一一对应；这里不按 spec 遍历渲染，
 * 因为每个字段的控件形态差别很大（厂商下拉 / 模型文本 / 多行 Prompt / 量表档位），
 * 强行抽象出一个通用渲染器反而会更难读。`JUDGE_OPERATOR_SPEC` 的用途是
 * 给测试与文档一份**可断言**的字段清单（`tests/wizard-judge.spec.ts`）。
 */
function JudgeBlock({
  judge,
  onChange,
  providers,
}: {
  judge: JudgeDraft | null;
  onChange: (next: JudgeDraft | null) => void;
  providers: readonly ModelProvider[];
}): React.ReactElement {
  const enabled = judge !== null;
  const firstProvider = providers[0]?.id ?? '';
  const err = judge === null ? null : judgeConfigError(judge);
  const warns = judge === null ? [] : judgeWarnings(judge);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{JUDGE_OPERATOR_SPEC.label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              onChange(e.target.checked ? defaultJudgeDraft(firstProvider) : null)
            }
          />
          <span className="font-medium text-foreground">{JUDGE_OPERATOR_SPEC.hint}</span>
        </label>

        {judge === null ? null : (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex w-[200px] flex-col gap-1">
                <Label htmlFor="judge-provider">裁判模型厂商</Label>
                <Select
                  id="judge-provider"
                  value={judge.modelProviderId}
                  onChange={(e) => onChange({ ...judge, modelProviderId: e.target.value })}
                >
                  {providers.length === 0 ? <option value="">（尚未配置厂商）</option> : null}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.isActive}>
                      {p.name}
                      {p.isActive ? '' : '（已停用）'}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex w-[180px] flex-col gap-1">
                <Label htmlFor="judge-model">裁判模型</Label>
                <Input
                  id="judge-model"
                  value={judge.modelId}
                  placeholder="如 gpt-4o-mini"
                  onChange={(e) => onChange({ ...judge, modelId: e.target.value })}
                  className="num-mono"
                />
              </div>

              <div className="flex w-[110px] flex-col gap-1">
                <Label htmlFor="judge-scale">量表上界</Label>
                <Select
                  id="judge-scale"
                  value={String(judge.scaleMax)}
                  onChange={(e) =>
                    onChange({ ...judge, scaleMax: Number(e.target.value) as 1 | 5 | 10 })
                  }
                  className="num"
                >
                  <option value="1">1 分制</option>
                  <option value="5">5 分制</option>
                  <option value="10">10 分制</option>
                </Select>
              </div>

              <div className="flex w-[130px] flex-col gap-1">
                <Label htmlFor="judge-pass">通过阈值（量表内）</Label>
                <Input
                  id="judge-pass"
                  type="number"
                  min={0}
                  max={judge.scaleMax}
                  step={1}
                  value={String(judge.passScoreOnScale)}
                  onChange={(e) => onChange({ ...judge, passScoreOnScale: Number(e.target.value) })}
                  className="num"
                />
                {/*
                  把归一化后的值显式显示出来：用户填的是「量表内分」，
                  而提交给服务端的是 0.6 这种归一化值。不显示换算结果，
                  用户会以为阈值就是自己填的那个数，后续对不上时报错难查。
                */}
                <span className="num text-2xs text-muted-foreground">
                  = {judgeScaleThresholdToNormalized(judge.passScoreOnScale, judge.scaleMax).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="judge-prompt">评分 Prompt</Label>
              <Textarea
                id="judge-prompt"
                value={judge.promptTemplate}
                onChange={(e) => onChange({ ...judge, promptTemplate: e.target.value })}
                className="min-h-[110px] font-mono text-xs"
                placeholder="支持 {{input}} / {{output}} / {{reference}} 占位符"
              />
            </div>

            {err !== null ? <p className="text-2xs text-eval-fail">{err}</p> : null}
            {warns.map((w) => (
              <p key={w} className="text-2xs text-eval-warn">
                {w}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 单个算子的内联参数区（K 值 / Schema / 容差 / 正则 / 阈值 / 权重）。 */
function EvaluatorParams({
  spec,
  selected,
  onPatch,
}: {
  spec: (typeof RULE_OPERATOR_SPECS)[number];
  selected: SelectedEvaluator;
  onPatch: (next: Partial<SelectedEvaluator>) => void;
}): React.ReactElement {
  const err = operatorConfigError(selected);

  return (
    <div className="flex flex-wrap items-end gap-3 pl-6">
      {spec.fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          config={selected.config}
          onChange={(nextConfig) => onPatch({ config: nextConfig })}
        />
      ))}

      <div className="flex w-[110px] flex-col gap-1">
        <Label htmlFor={`w-${spec.key}`}>权重</Label>
        <Input
          id={`w-${spec.key}`}
          type="number"
          min={0}
          step={0.5}
          value={String(selected.weight)}
          onChange={(e) => onPatch({ weight: Number(e.target.value) })}
          className="num"
        />
      </div>

      {/*
        「通过阈值」留空 ⇒ 该算子不参与 passed 的 AND 判定，只贡献分数。
        这必须是一个**明确可表达**的状态（空输入 = null），不能悄悄默认成 0.6。
      */}
      <div className="flex w-[130px] flex-col gap-1">
        <Label htmlFor={`pt-${spec.key}`}>通过阈值（可空）</Label>
        <Input
          id={`pt-${spec.key}`}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={selected.passThreshold === null ? '' : String(selected.passThreshold)}
          placeholder="不判定"
          onChange={(e) =>
            onPatch({ passThreshold: e.target.value === '' ? null : Number(e.target.value) })
          }
          className="num"
        />
      </div>

      {err !== null ? <p className="w-full text-2xs text-eval-fail">{err}</p> : null}
    </div>
  );
}

/**
 * 参数输入框。
 *
 * 直接产出**整个 config 对象**而不是单个字段：`config` 是判别联合，
 * 让调用方自己 `{...config, [name]: v}` 会在 TS 里退化成 `any`，
 * 一旦字段名写错（`caseSensitive` → `case_sensitive`）就没有任何东西拦得住。
 */
function FieldInput({
  field,
  config,
  onChange,
}: {
  field: RuleField;
  config: SelectedEvaluator['config'];
  onChange: (next: SelectedEvaluator['config']) => void;
}): React.ReactElement {
  const id = `f-${config.key}-${field.name}`;
  const value = (config as unknown as Record<string, unknown>)[field.name];

  if (field.kind === 'bool') {
    return (
      <label htmlFor={id} className="flex h-9 items-center gap-2 text-xs text-foreground">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange({ ...config, [field.name]: e.target.checked })}
        />
        {field.label}
      </label>
    );
  }

  if (field.kind === 'json') {
    return (
      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <Label htmlFor={id}>{field.label}</Label>
        <Textarea
          id={id}
          defaultValue={JSON.stringify(value ?? {}, null, 2)}
          onChange={(e) => {
            try {
              onChange({ ...config, [field.name]: JSON.parse(e.target.value) });
            } catch {
              // 半截 JSON 期间不动 config：让上一次解析成功的值留在快照里，
              // 而不是把 `{}` 写进提交体。错误由 operatorConfigError 在提交前统一报。
            }
          }}
          className="min-h-[64px] font-mono text-xs"
        />
      </div>
    );
  }

  if (field.kind === 'text') {
    return (
      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <Label htmlFor={id}>{field.label}</Label>
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange({ ...config, [field.name]: e.target.value })}
          className="num-mono"
        />
      </div>
    );
  }

  return (
    <div className="flex w-[130px] flex-col gap-1">
      <Label htmlFor={id}>{field.label}</Label>
      <Input
        id={id}
        type="number"
        min={field.min}
        {...(field.kind === 'float' ? { max: field.max, step: 0.01 } : { step: 1 })}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e) => onChange({ ...config, [field.name]: Number(e.target.value) })}
        className="num"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤 4 · 确认并发与运行
// ---------------------------------------------------------------------------

function StepConfirm({
  name,
  onNameChange,
  concurrency,
  onConcurrencyChange,
  preflight,
  preflightError,
  evaluatorCount,
}: {
  name: string;
  onNameChange: (v: string) => void;
  concurrency: string;
  onConcurrencyChange: (v: string) => void;
  preflight: RunPreflightType | null;
  preflightError: string | null;
  evaluatorCount: number;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>4 · 确认并发与运行</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-[260px] flex-1 flex-col gap-1">
            <Label htmlFor="wizard-name">评测名称</Label>
            <Input
              id="wizard-name"
              value={name}
              required
              maxLength={120}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="如：客服问答集 v1 · T1 基线"
            />
          </div>
          <div className="flex w-[140px] flex-col gap-1">
            <Label htmlFor="wizard-concurrency">并发数</Label>
            <Input
              id="wizard-concurrency"
              type="number"
              min={1}
              max={32}
              step={1}
              value={concurrency}
              onChange={(e) => onConcurrencyChange(e.target.value)}
              className="num"
            />
          </div>
        </div>

        <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          配置摘要：<span className="num">{evaluatorCount}</span> 个算子，
          并发 <span className="num">{concurrency}</span>。
        </div>

        {preflightError !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-xs text-eval-fail">
            前置检查失败：{preflightError}
          </div>
        ) : null}

        {preflight === null ? null : preflight.blockers.length === 0 ? (
          <p className="text-xs text-eval-pass">前置检查通过，可以启动评测。</p>
        ) : (
          <ul className="flex flex-col gap-1 rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-xs text-eval-fail">
            {preflight.blockers.map((code) => (
              <li key={code}>{blockerText(code).message}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
