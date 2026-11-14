# AGENTS.md（源码仓内的入口指针）

> **本文件不维护内容**，唯一正本是仓库**上一级目录**的 [`../AGENTS.md`](../AGENTS.md)。
>
> 存在理由：本目录 `D:\Evaluation Middle Platform\src` 才是 **Git 仓库根**
> （`git rev-parse --show-toplevel` 返回它）。若 AI 工具（Zed / zcode / Codex）
> 直接以 `src/` 为工作区打开，上一条路径就是它能看到那个入口的唯一通道。

## 请按顺序读

1. [`../AGENTS.md`](../AGENTS.md) —— 协作唯一入口：目录布局、阅读顺序、硬性边界、门禁命令、契约规则、提交纪律
2. [`../docs/工程规则.md`](../docs/工程规则.md) —— 工程规则唯一正文
3. [`docs/HANDOFF.md`](docs/HANDOFF.md) —— **接手交接包**（首次接手 / 换工具时读；本文件在仓库内，随 git 跟踪）
4. [`docs/facts/`](docs/facts/) 中与本任务相关的事实文档
5. [`contracts/`](contracts/) —— 可编译的接口 / 数据契约
6. 当前 [`docs/Spec/`](docs/Spec/) 任务规格

> `docs/` 与上一级的 `../docs/` **内容逐字节相同**（镜像关系）。
> 改动必须两边同步；**`src/docs/` 是入库的那份**。

## 最短恢复上下文

```bash
cd "D:/Evaluation Middle Platform/src"
git log --oneline -9          # 头部应为 5277fd5 merge(M2)…
git status --porcelain -uall  # 应为空
```

当前状态：**M1 与 M2 已完成合并并推送远端（`main` = `origin/main` = `5277fd5`，`v0.1.0-m2` 已推）。M3 已立项：`docs/Spec/SPEC-M3.md` v0.2，七条裁定已回填（2026-11-14），Batch 1 未开工。**
