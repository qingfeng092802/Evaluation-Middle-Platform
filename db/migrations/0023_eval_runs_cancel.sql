-- 0023 · eval_runs.cancel_requested — 协作式取消通道（M5 Q3 裁定：Synchronize 中断旧跑批）
-- 事实源：docs/Spec/SPEC-M5.md §1-Q3 / §2.6
-- 语义：synchronize 事件到达时把同 PR 旧 head_sha 的 RUNNING run 置 cancel_requested=true；
--       worker 在每 Case 边界检查并协作式终止（RUNNING → CANCELLED，guard 现行合法边）。
-- 不改 guard：RUNNING → CANCELLED 与 PENDING → CANCELLED 在 0016 起就是合法边
--       （排队取消是既有语义）；本迁移**只加列，不收窄状态机**（2026-11-19 需求方裁定
--       口径与现状的偏差已在 SPEC-M5 执行留档中申报，待晨会复核）。
-- 列级纪律：cancel_requested 只允许 false → true 一次置位（回填式回滚属未来专项，
--       MVP 不提供）；由仓储层单语句置位，无需独立触发器。

ALTER TABLE eval_runs ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
