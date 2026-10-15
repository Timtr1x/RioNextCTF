# 多 Worker 配对评测（D08）：Harness 与指标定义

> 状态：未运行。本机没有真实模型凭据，诚实留空。本文件只定义可复跑的配对方法与指标，不含任何测得的数字。

## 固定条件

- 同一源码提交、同一镜像 digest、同一模型与参数、同一任务输入、同一环境初始快照、同一战役总预算、同一时间上限、同一成功判据（沿用现有独立验收，不看 Worker 自报）。
- 唯一变量：`spec.execution_policy.max_execute_workers` 1 vs 2，宿主上限同步为 1 vs 2。

## 任务样本（每类至少 3 个固定任务，先工程冒烟）

1. 单条强依赖链：检验并行没有大量空转和重复探索。
2. 多个独立方向：检验两个 Worker 是否产生实际重叠收益。
3. 共享状态/资源冲突：检验并发不破坏证据与目标环境。

普通 assessment 与 CTF 分别记录，不混成一个总成功率。CTF 有 Flag 不代替 assessment 的独立验证与覆盖收口。

## 指标

| 指标 | 采集 |
| --- | --- |
| 成功率与成功证据 | 现有独立验收 |
| 墙钟耗时、首个有效证据时间 | 事件流时间戳 |
| 总 calls/tokens/cost | 预算账本（全 Worker 合计，含重试与恢复） |
| 实际重叠时间 | task_runs 的 created/updated 区间交集 |
| 重复/冲突工具调用数 | invocations 按 (purpose, prompt_hash) 聚合 |
| Provider 排队时长 | model.queued/dequeued 事件差 |
| Controller 失权/unknown/恢复耗时 | run.lease_rejected、invocation.uncertain、恢复事件 |
| 错误确认、跨 Run 引用污染 | 正确性回归清单 |

## 复跑入口（凭据就位后）

```bash
# 每题各跑一次 1 和 2，对照写回本文档
rionext run --spec <task.json> --workers 1 --max-concurrent-execute 1 --data-dir <run1>
rionext run --spec <task.json> --workers 2 --max-concurrent-execute 2 --data-dir <run2>
```

小样本只说明能运行，不能证明总体更优；据此调整默认 Worker 数需要更大的任务集与多次重复。首次发布默认仍为 1。
