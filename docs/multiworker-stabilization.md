# RioNext 多 Worker 稳定化：实施说明（H01–H05）

> 实施基线：`087cda3`（多 Worker 主链路）。本论提交 C01–C09 对应《RioNext 多 Worker 稳定化详细开发方案 v1.1》。
> 验收映射见 docs/multiworker-acceptance.md；本文件记接口、不变量与迁移。

## 范围

默认行为仍是单 Worker；两个 Execute Worker 经 `--workers 2` + 宿主上限同时开启。未做的事不变：不同时跑 Decide+Execute、不加固定专业 Agent、不加消息队列或远程 Worker 平台。

## H01 信号量与模型调用生命周期

`src/gateway/semaphore.ts`：Permit 制。`acquire({signal, deadlineAt})` 返回 Promise<Permit>；`release()` 幂等。交接原子化：release 在同一个同步片段内把槽直接授予队首有效等待者（active 不变），无等待者才减一。等待者三态互斥（queued/granted/cancelled），abort/deadline 立即移出队列并清理定时器与监听器。构造拒绝非法容量（0/负/小数/NaN/Infinity/非安全整数）。

`src/gateway/gateways.ts`：模型调用生命周期为 prepare+reserve → （有信号量则排队）→ 获槽后重验权（campaign 状态、cancel_epoch、run state/fence、DB 最新 deadline、controller generation 仍持锁）→ 计数并发送 → 网关自己观察流的终结（单次底层 result promise），预算与槽位恰好结算一次，与消费方是否调用 result、调用几次无关。排队失败与发送前抛错按"确定未发送"释放预留；发送后失败保留责任。

## H02 容器初始化协调

`src/tools/container-init.ts`：进程级协调器，键是实际容器名。首位调用者是创建者，同 fingerprint 的加入者共享同一个 Promise；fingerprint（镜像、挂载根、网络、资源上限）不同即显式冲突。Entry 登记先于任何 await；清理按身份比对，旧 Entry 的 finally 删不到新重试。创建者不携带调用方 signal（取消隔离），等待者只取消自己的等待。

`src/tools/kali-runtime.ts`：容器创建带 `rionext.from=master` 与 `rionext.fp=<fingerprint>` 标签。冷启动路径：运行中→校验归属+fp（每进程一次，之后进 verified 缓存）；退出态→仅删除本项目拥有的；名称冲突→重新 inspect，匹配即复用，绝不 rm -f。跨进程：`<dataDir>/locks/init-<name>.lock`（O_EXCL、TTL 120s、令牌校验释放），拿不到锁的进程轮询等待容器出现后验明归属再复用；无法安全判断时报 `kali_init_locked`/`kali_init_conflict`，保留容器。pw-daemon 的首次浏览器 launch 与每会话创建都改成 Promise 合并（注意：该改动在 `docker/kali/pw/pw-daemon.mjs`，随下次镜像构建生效；当前镜像 8735af70 内的 daemon 已有按会话隔离，只是缺合并启动）。

## H03 Controller 与 Run 租约围栏

- `controller_locks`：续租携带 owner+generation 且要求未过期；失权返回 false，Engine 立即停止补充并取消本地 Run。release 只把行置为过期（不删行），generation 不复位。过期后重取即使同 owner 也进新 generation。统一过期定义：`lease_until <= now`（heartbeat_at 仅诊断；无 lease_until 的旧行回退心跳陈旧判定）。
- `task_runs.controller_generation`（迁移 v6，可空）：Run 绑定领取它的 Controller 代数。`claimNextStep`/`claimDecide` 收 ControllerLease，在同一事务内验锁；先撤权到期 Run 再算容量；容量=活跃+恢复占槽（有未决调用的 lease_expired Run 仍占槽）；存储层强制 Decide/Execute 互斥。`claimNextStepAsOwner`/`claimDecideAsOwner` 是测试/播种便捷路径：真实取锁、claim、锁留在调用者手里（用完显式 release）。
- `heartbeatRun(ctrl, {run_id, fence}, deadline)`：WHERE 子句同时要求 run 存活未到期、fence 匹配、controller_generation 匹配、对应 Controller 锁仍有效；只延长不缩短，不越过战役硬截止。失权返回 `{renewed:false}`，Worker 立即停止准入并触发本 Run 取消。
- Worker 来源的业务写（observation/fact/finding/propose_step/propose_plan/checkpoint/finish）在真正写事务内重验租约（`assertWorkerWrite`）。`finishRun` 收调用方 expected fence/generation；恢复重放走无 expected 的受信恢复路径。失权后的迟到结果仍可归档到原 invocation，但不能改变图结论。

## H04 外部调用恢复与持久回执

- `EffectAdapter.describe(invocationId, payload)`：无副作用地给出 `{handle, queryable, replaySafe}`。permit 事务内持久化 `invocations.execution_handle`（迁移 v6）。Kali 句柄 `kali_<inv>`（queryable，非 replaySafe）；文件适配器 `ex_<inv>`（queryable，replaySafe）。
- `queryEvidence(handle)`：`running | completed | failed(effect: none|possible) | not_started | unknown`。容器消失、记录缺失、查询超时都不是 not_started 的证据。
- `DispatchGate.recover` 决策表：prepared 仅在所属 Run 发送权已撤（Run 不再存活）时按 not_dispatched 释放；dispatching/running/uncertain 无句柄→永远 uncertain（删除了"无 external_id 即 never_sent"的推导）；有正向 not_started 证据且发送权已撤→释放；completed/failed→按 `rec:<invocation>` 幂等对账；查询仍 running→低频轮询。恢复事件去重。`engine.adjudicate` / `POST /api/campaigns/:id/reconcile`（带 verdict）是受信人工裁决：confirmed_not_sent / confirmed_completed / acknowledged_unknown，记录 Actor/依据/原状态；acknowledged_unknown 保持 uncertain、继续阻塞普通收口。收口被未决调用阻塞时列出 invocation id 与原因。
- Kali 每次受控执行（前台/后台、同步/异步）写 `.rionext-ops/<id>.json`（原子 tmp+rename）：执行身份、容器、Run、argv 摘要、阶段、退出码、时间戳；另有容器内 pid 标记 `<id>.pid` 与环境标记 `RIONEXT_EXEC=<id>`。`KaliRuntime.cancelExecution` 先核对记录身份与 /proc/<pid>/environ 标记，再 kill 进程组并复核；容器已停或标记已死即正向确认。杀掉宿主 docker CLI 不再被当作容器侧已终止的证明。

## H05 配置贯通

`resolveRuntimeConfig(dataDir, flags, env)` 是唯一入口：flags > env > runtime.json（白名单 `max_concurrent_execute`、`max_inflight_model_calls`）> 默认。CLI 三分支（run/ui/contest）、EngineHost、openEngine（contest runner 经此）共用。`--workers` 只被 run/create/start/contest 接受，其余命令显式拒绝。状态投影 `execution_capacity`（requested/runtime_limit/effective/active/recovering/waiting_reason）与 `provider_capacity`（service_process 范围、limit、active、queued）。

## 不变量落点（I01–I12）

| 不变量 | 实现处 |
| --- | --- |
| I01–I03 信号量界 | semaphore.ts 原子交接 + Permit 幂等释放 |
| I04 容器初始化唯一创建者 | container-init.ts + 锁文件 + 归属标签 |
| I05/I06 失权不得领取/续租/写入 | service.ts 租约校验、assertWorkerWrite、submitRunOutcome 锁检查 |
| I07 恢复占槽 | occupiedExecuteSlotsTx（活跃+未决调用） |
| I08 无回执不推 never_sent | recover 决策表 |
| I09 幂等结算 | budget_entries 幂等键（settle/liability/reconcile） |
| I10 不自动重放未知写 | recover 从不重发；replaySafe=false 的适配器不重试 |
| I11 统一配置 | resolveRuntimeConfig + 状态投影 |
| I12 预算不倍增 | 战役级 budget_accounts 总额，与 Worker 数无关 |

## 迁移 v6

新增 `task_runs.controller_generation INTEGER`、`invocations.execution_handle TEXT`，皆可空。新库首开即记录版本 6；v2–v5 旧库升级到同一结构；迁移可重入（addColumn 幂等 + 版本行最后写）；版本高于本二进制的库拒绝启动。旧 Run（无 generation）不被任何当前 generation 续租，由受信恢复路径处理。回滚分两件事：关闭并行（workers/上限设 1，代码修复保留）；退回旧二进制需要先处理未决调用并恢复升级前一致性备份（WAL 存在时不能只复制主库文件）。

## 仍未验收（如实记录）

- D04 真实双 Run 浏览器并行：本机 Docker 不解析 host.docker.internal，跳过（环境限制）；按会话隔离在 fake 层与既有隔离测试覆盖，pw-daemon 合并启动随下次镜像构建生效。
- D08 单双 Worker 真实模型配对：无可用模型凭据，未跑；docs/multiworker-benchmark.md 记录可复跑的 harness 与指标定义，不填假数字。
- pw-daemon.mjs 的 launch 合并：需要重建镜像（`npm run kali:build`）才进入运行环境。
