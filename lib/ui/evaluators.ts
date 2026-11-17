/**
 * PG-07 算子库的展示派生（M4 Batch 4，`US-016`）。
 *
 * 纯函数：清单分区（内置只读 / 自定义模板）与新建模板表单的可提交判定。
 */
import type { EvaluatorTemplate } from '@eval-platform/contracts';

/** 清单分区：内置算子是展示位（只读），自定义模板可编辑。 */
export function partitionTemplates(items: readonly EvaluatorTemplate[]): {
  builtin: readonly EvaluatorTemplate[];
  custom: readonly EvaluatorTemplate[];
} {
  return {
    builtin: items.filter((i) => i.isBuiltin),
    custom: items.filter((i) => !i.isBuiltin),
  };
}

export interface JudgeTemplateForm {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly promptTemplate: string;
  readonly scaleMax: 1 | 5 | 10;
  readonly passThreshold: number;
  readonly temperature: number;
}

export const EMPTY_JUDGE_FORM: JudgeTemplateForm = {
  key: '',
  displayName: '',
  description: '',
  modelProviderId: '',
  modelId: '',
  promptTemplate: '',
  scaleMax: 1,
  passThreshold: 0.6,
  temperature: 0,
};

/** 新建表单可提交：key 用 `judge.<slug>` 惯例（非空即接受，服务端做唯一性裁定）。 */
export function canSubmitJudgeForm(f: JudgeTemplateForm): boolean {
  return (
    f.key.trim().length > 0 &&
    f.displayName.trim().length > 0 &&
    f.modelProviderId.trim().length > 0 &&
    f.modelId.trim().length > 0 &&
    f.promptTemplate.trim().length > 0
  );
}

/** 编辑表单：key 不可改（唯一键），其余取模板现值。 */
export function judgeFormOf(t: EvaluatorTemplate): JudgeTemplateForm {
  const c = t.defaultConfig as {
    key: 'judge';
    modelProviderId: string;
    modelId: string;
    promptTemplate: string;
    scaleMax?: 1 | 5 | 10;
    passThreshold?: number;
    temperature?: number;
  };
  return {
    key: t.key,
    displayName: t.displayName,
    description: t.description ?? '',
    modelProviderId: c.modelProviderId,
    modelId: c.modelId,
    promptTemplate: c.promptTemplate,
    scaleMax: c.scaleMax ?? 1,
    passThreshold: c.passThreshold ?? 0.6,
    temperature: c.temperature ?? 0,
  };
}

/** PATCH 判定：只有 config 相关字段变化才需要发 `config`（name/description 走独立字段）。 */
export function judgeFormChanged(a: JudgeTemplateForm, b: JudgeTemplateForm): boolean {
  return (
    a.modelProviderId !== b.modelProviderId ||
    a.modelId !== b.modelId ||
    a.promptTemplate !== b.promptTemplate ||
    a.scaleMax !== b.scaleMax ||
    a.passThreshold !== b.passThreshold ||
    a.temperature !== b.temperature
  );
}
