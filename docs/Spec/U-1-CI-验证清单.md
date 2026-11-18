# U-1 CI 验证清单 · H-11 `taskkill` 子孙清理分支（关闭 U-1 的唯一路径）

> **固定口径（每次被问必须原样回答，不得改写成「已验证通过」）**：
> 「H-11 的 `taskkill` 子孙清理分支未覆盖。本机 SIGKILL 生效，taskkill 分支被安全分类器拒绝。
> 该分支的清理效果需在 CI 或另一台 Windows 机器确认。」
> 出处：`M1-验收记录.md` §13.4；关闭条件原文：`HANDOFF.md` §4.1。
>
> 本清单给出**可复验的执行步骤与判定读数**。跑通并留档前，U-1 在一切文档中维持「未验证」。

---

## 1. 环境要求

| 项 | 要求 | 理由 |
|---|---|---|
| Runner | GitHub Actions **`windows-latest`**（或任一台有真实 kill 权限的 Windows 机器，**非开发沙箱**） | Linux runner 上 `killTree` 走 `child.kill(signal)`，与 Windows 语义不同；**不得默认「本机绿 = CI 绿」**（HANDOFF §4.1 原文） |
| 数据库 | PostgreSQL 16 service container，端口映射 **5433:5432**，凭证与默认连接串逐字一致：`POSTGRES_USER=eval` / `POSTGRES_PASSWORD=eval_local_dev_only` / `POSTGRES_DB=eval_platform` | `db/migrate.ts` 的 `DEFAULT_DATABASE_URL` 即此串；测试进程在无 `.env` 时按它直连 |
| Node | 24.x（`engines: >=20`，开发机为 v24.18.0） | — |
| 不需要 | Docker / LiteLLM / 真实厂商 Key | 该 spec 自起本地计数网关 :8791、自 spawn 真 worker（`node --import tsx worker/index.ts`），零外部依赖 |

## 2. workflow 片段（可直接粘贴；git root 即 `src/`，无需 working-directory）

```yaml
name: u1-h11-verification
on:
  workflow_dispatch: {}

jobs:
  u1-h11:
    runs-on: windows-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: eval
          POSTGRES_PASSWORD: eval_local_dev_only
          POSTGRES_DB: eval_platform
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U eval"
          --health-interval 3s
          --health-timeout 3s
          --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: U-1 · H-11（taskkill 子孙清理分支）
        run: npx vitest run tests/heartbeat-worker.spec.ts
```

## 3. 判定读数（**全部满足才可写「已验证」**）

1. **测试结果**：`Test Files 1 passed` / `Tests 3 passed / 0 skipped / 0 failed`（H-10 / H-11 / H-12）。
2. **H-11 读数行**：CI 日志含 `[H-11] lease=… caseDelay=… gatewayHits=… claimLines=… reclaimLines=… frozenLines=…`，且 `reclaimLines≥1`、结果行数 = Case 数、`gatewayHits` 每条 ∈ [1,2]（at-least-once 口径）。
3. **taskkill 分支证据**：CI 日志含 `[killTree] taskkill /PID … /T /F exit=0`（`1175b3a` 起打点；被拒环境为非 0——本机实测 `exit=128`，与固定口径吻合；**windows runner 上必须为 0**，`spawn-error` 同样不通过）。
4. 三项齐后：把 `M1-验收记录.md` §13.4 的 U-1 行按固定口径**改写为已验证**并附 CI 日志链接；`SPEC-M4.md` §0 检查 3 同步 ✅。**改写前维持「未验证」。**

## 4. 备选路径

无 `windows-latest` 配额时：任何一台有管理员权限、非沙箱的 Windows 机器跑同一条命令
（`npx vitest run tests/heartbeat-worker.spec.ts`），按 §3 同样取证——「另一台 Windows 机器」
与 CI 等价（HANDOFF §4.1 原文两种环境二选一）。

---

**记录纪律**：执行后本文件只追加「执行记录」一节（日期 / runner / 三项读数 / 日志链接），不删改上文。
