-- 0026 · outbound_dispatch_logs.gate_id 放宽为可空（M5 Batch 3，Q5 集成级回传）
-- 事实源：docs/Spec/SPEC-M5.md §2.4；`channel_kind='github'` 的 Commit Status
--       回传是 **run 维**（集成级），可能发生在无任何门禁规则的数据集上（NO_GATE
--       也要如实回传 success）——run 维留痕塞一个伪 gate_id 就是造假，故放宽。
-- 语义不变式：feishu / wecom / webhook 三个规则级通道仍必须带 gate_id（由应用层
--       dispatchGateResult 保证——它们本就逐规则调用）。

ALTER TABLE outbound_dispatch_logs ALTER COLUMN gate_id DROP NOT NULL;
