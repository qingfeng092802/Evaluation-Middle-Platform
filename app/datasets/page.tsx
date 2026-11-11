'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  DatasetListResponse,
  DatasetVersionDetail,
  DatasetVersionListResponse,
  ImportValidationReport,
} from '@eval-platform/contracts';
import type { Dataset, DatasetVersion } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { datasetsTableColumns } from '@/components/datasets/datasets-table-columns';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { formatTimestamp, truncateHash } from '@/lib/format';
import {
  importBlockedReason,
  importCanCommit,
  inferFormat,
  versionFrozenNotice,
} from '@/lib/ui/datasets';
import { importIssueLine, importSummary } from '@/lib/ui/runs';

/**
 * `PG-05` · 评测集。
 *
 * 四块按 `pages-and-flows.md` PG-05 的区域顺序排：标题栏 → 列表 →
 * 上传面板（校验结果区）→ 版本历史（**内联展开**预览，不跳页、不弹窗）。
 *
 * 列表列定义在 `components/datasets/datasets-table-columns.tsx`，
 * 那里逐列对着 `[FE-02]` 交付物 1 的原文，并被 `tests/datasets-render-parity.spec.ts`
 * 用真实 `<DataTable>` 渲染后逐字断言。
 *
 * 「明确不做」的两件事在这里体现为**代码里没有**：
 * 没有删除版本、没有导出 JSONL。不是藏起来，是根本不实现。
 */
export default function DatasetsPage(): React.ReactElement {
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const columns = React.useMemo(
    () =>
      datasetsTableColumns({
        expandedId,
        onToggle: (id) => setExpandedId((cur) => (cur === id ? null : id)),
      }),
    [expandedId],
  );

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '评测集', href: '/datasets' }]}
      actions={
        <Button asChild size="sm">
          <a href="#upload-panel">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> 导入评测集
          </a>
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">评测集</h1>

        {datasets.error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            加载失败：{datasets.error.message}
          </div>
        ) : null}

        <DataTable<Dataset>
          columns={columns}
          rows={datasets.data?.items ?? []}
          getRowId={(d) => d.id}
          loading={datasets.loading}
          refreshing={datasets.refreshing}
          emptyKey="datasets"
          rowAriaLabel={(d) => `评测集 ${d.name}`}
        />

        {expandedId === null ? null : (
          <VersionHistory
            datasetId={expandedId}
            onChanged={datasets.reload}
            onClose={() => setExpandedId(null)}
          />
        )}

        <UploadPanel
          datasets={datasets.data?.items ?? []}
          onCommitted={() => {
            datasets.reload();
          }}
        />
      </div>
    </AppShellWithTheme>
  );
}

// ---------------------------------------------------------------------------
// 区域 4 · 版本历史（内联展开）
// ---------------------------------------------------------------------------

/**
 * 版本历史 + 预览。
 *
 * 一个评测集可能有几十个版本，这里一次拉全（接口无分页参数），
 * 因为「MU 每次导入都产生版本」意味着版本数天然很少，分页只会增加点击。
 */
function VersionHistory({
  datasetId,
  onClose,
}: {
  datasetId: string;
  onChanged: () => void;
  onClose: () => void;
}): React.ReactElement {
  const versions = useApi(DatasetVersionListResponse, `/api/datasets/${datasetId}/versions`);
  const [previewNo, setPreviewNo] = React.useState<number | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>版本历史</CardTitle>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {versions.loading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : versions.error !== null ? (
          <p className="text-xs text-eval-fail">加载失败：{versions.error.message}</p>
        ) : (versions.data?.items ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">该评测集还没有版本，请在上方面板导入。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {(versions.data?.items ?? []).map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                expanded={previewNo === v.versionNo}
                onToggle={() => setPreviewNo((cur) => (cur === v.versionNo ? null : v.versionNo))}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function VersionRow({
  version,
  expanded,
  onToggle,
}: {
  version: DatasetVersion;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="num font-medium text-foreground">v{version.versionNo}</span>
        <span className="num text-muted-foreground">{version.caseCount} 条</span>
        <span className="num-mono text-muted-foreground" title={version.contentHash}>
          {truncateHash(version.contentHash)}
        </span>
        <span className="text-muted-foreground">{version.createdBy}</span>
        <span className="num-mono text-muted-foreground">{formatTimestamp(version.createdAt)}</span>
        <button
          type="button"
          className="ml-auto text-primary underline-offset-4 hover:underline"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          预览
        </button>
      </div>
      {expanded ? <VersionPreview datasetId={version.datasetId} versionNo={version.versionNo} /> : null}
    </li>
  );
}

/** 版本预览：顶部固定不可变提示 + Case 明细表。 */
function VersionPreview({
  datasetId,
  versionNo,
}: {
  datasetId: string;
  versionNo: number;
}): React.ReactElement {
  const detail = useApi(
    DatasetVersionDetail,
    `/api/datasets/${datasetId}/versions/${String(versionNo)}`,
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <p className="text-xs font-medium text-eval-warn">{versionFrozenNotice(versionNo)}</p>
      {detail.loading ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : detail.error !== null ? (
        <p className="text-xs text-eval-fail">加载失败：{detail.error.message}</p>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b border-border">
                <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                  Seq
                </th>
                <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                  Case Key
                </th>
                <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                  Query
                </th>
                <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                  检索标注
                </th>
              </tr>
            </thead>
            <tbody>
              {(detail.data?.cases ?? []).map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="num px-2 py-1 text-muted-foreground">{c.seq}</td>
                  <td className="num-mono px-2 py-1" title={c.caseKey}>
                    {truncateHash(c.caseKey)}
                  </td>
                  <td className="max-w-[28rem] truncate px-2 py-1">{c.input.query}</td>
                  <td className="num px-2 py-1 text-muted-foreground">
                    {c.retrieval === null ? '—' : `${c.retrieval.relevant.length} 条`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 区域 3 · 上传面板
// ---------------------------------------------------------------------------

/**
 * 上传面板：文件 → 校验（服务端）→ 生成新版本。
 *
 * 校验**必须走服务端** `/api/datasets/imports/validate`：解析与行号口径只在
 * `lib/import/` 有一份实现，前端自算一遍就等于新增一处会漂移的真相。
 */
function UploadPanel({
  datasets,
  onCommitted,
}: {
  datasets: readonly Dataset[];
  onCommitted: () => void;
}): React.ReactElement {
  const [targetId, setTargetId] = React.useState<string>('');
  const [filename, setFilename] = React.useState<string>('');
  const [content, setContent] = React.useState<string>('');
  const [report, setReport] = React.useState<ImportValidationReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  // 默认选第一个评测集，但**不覆盖**用户已经选过的值。
  const effectiveId = targetId !== '' ? targetId : (datasets[0]?.id ?? '');

  const format = inferFormat(filename, content);
  const canCommit = importCanCommit(report);
  const blocked = importBlockedReason(report);

  async function onValidate(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await apiPost(ImportValidationReport, '/api/datasets/imports/validate', {
        content,
        format,
      });
      setReport(r);
    } catch (e) {
      // 校验接口自己失败（文件为空 / 网络）与「数据有坏行」是两回事，
      // 后者是 200 + report，前者才是异常。
      setReport(null);
      setError(e instanceof Error ? e.message : '校验失败');
    } finally {
      setBusy(false);
    }
  }

  async function onCommit(): Promise<void> {
    if (effectiveId === '') {
      setError('请先创建一个评测集');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 提交的是**文件原文**，服务端解析后走同一条落库路径。
      // 浏览器绝不自己拆 JSONL / CSV —— 行号口径只能有一处实现。
      const created = await apiPost(
        DatasetVersionDetail,
        `/api/datasets/${effectiveId}/imports`,
        { content, format, source: 'import' },
      );
      setDone(`已生成 v${String(created.versionNo)}`);
      setReport(null);
      setContent('');
      setFilename('');
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成版本失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="upload-panel">
      <CardHeader>
        <CardTitle>导入评测集</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <Label htmlFor="dataset-id">目标评测集</Label>
            <Select
              id="dataset-id"
              value={effectiveId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {datasets.length === 0 ? <option value="">（还没有评测集）</option> : null}
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <Label htmlFor="dataset-file">文件（JSONL / CSV）</Label>
            <Input
              id="dataset-file"
              type="file"
              accept=".jsonl,.csv,.json,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFilename(file.name);
                setReport(null);
                setDone(null);
                void file.text().then(setContent);
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="dataset-content">文件内容（可直接粘贴）</Label>
          <Textarea
            id="dataset-content"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setReport(null);
              setDone(null);
            }}
            placeholder='{"case_key":"c1","input":{"query":"…"}}'
            className="min-h-[120px] font-mono text-xs"
          />
          <p className="text-2xs text-muted-foreground">
            判定格式：<span className="num">{format.toUpperCase()}</span>（按扩展名，其次看首个字符）
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || content === ''} onClick={() => void onValidate()}>
            校验
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !canCommit || effectiveId === ''}
            onClick={() => void onCommit()}
          >
            生成新版本
          </Button>
          {busy ? <span className="text-xs text-muted-foreground">处理中…</span> : null}
          {done !== null ? <span className="text-xs text-eval-pass">{done}</span> : null}
        </div>

        {error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-xs text-eval-fail">
            {error}
          </div>
        ) : null}

        {report === null ? null : (
          <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              {importSummary(report.okCount, report.failedCount)}
            </p>
            {blocked !== null ? <p className="text-xs text-eval-fail">{blocked}</p> : null}
            {report.issues.length === 0 ? null : (
              <ul className="max-h-48 overflow-y-auto text-xs text-eval-fail">
                {report.issues.map((issue, i) => (
                  <li key={`${String(issue.line)}-${String(i)}`} className="num">
                    {importIssueLine(issue)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
