# RioNext 多 Worker 稳定化：验收映射（C01–C09）

> 基线 `087cda3`；最终测试：`npm test` 512 通过 / 0 失败 / 2 跳过（2026-10-15，Node v24.12.0，Windows）；`npm run build` 通过（tsc + vite）。
> 真实 Docker 验收：`node tests/docker-acceptance.mjs`，镜像 `rionext-kali:rolling` = sha256:8735af706f79721906d27fd1d04699519cbb1e6aa1e46a50d1f44436565a699e（既有镜像；本轮 pw-daemon.mjs 改动未包含在内），结果记录 docs/acceptance/docker-2026-10-15.json。

## H01 信号量（tests/gateway/semaphore.test.ts, model-lifecycle.test.ts）

| ID | 结果 |
| --- | --- |
| S01 交接复现（容量 1，A 释放后 C 同栈抢槽） | ✔ B 原子获槽，active 恒 ≤1 |
| S02 排队超时 | ✔ B 不获槽，终态 active=0/queued=0 |
| S03 入队前已 abort | ✔ 不入队不占槽 |
| S04 排队中 abort | ✔ Promise 终结，移出队列，预留释放 |
| S05 grant vs abort 同轮 | ✔ 单一胜者 |
| S06 grant vs deadline 同轮 | ✔ 一次授予或一次拒绝 |
| S07 重复 release | ✔ 不为负、不多唤醒 |
| S08 多等待者 FIFO | ✔ |
| S09 非法容量 | ✔ 全部构造拒绝 |
| S10 Provider 建流同步/异步抛错 | ✔ 槽归还，账目恰好一次 |
| S11 result 拒绝 | ✔ 槽归还，错误被消费，无 unhandled rejection |
| S12 业务方不调 result | ✔ 网关观察者照常归还与结算 |
| S13 多消费方 result | ✔ 不重复释放、不重复记账 |
| S14 排队期间战役取消 | ✔ 获槽后重验失败，Provider 发送次数=0 |
| S15 abort 未终结 | ✔ 槽位保留到真实终结 |
| S16 200 轮混合排队/超时/取消 | ✔ 计数归零，无累积 |

## H02 容器初始化（tests/kali/container-init.test.ts，严格 Fake）

| ID | 结果 |
| --- | --- |
| K01 同缺失容器两个冷启动 | ✔ 一次创建，双双成功 |
| K02 同进程不同 Runtime 同容器 | ✔ 共用 Entry |
| K03 不同 Campaign 共用 Contest 容器 | ✔ 按容器键合并 |
| K04 不同容器同时初始化 | ✔ 互不阻塞 |
| K05 首个等待者取消 | ✔ 第二个成功，取消者不继续执行 |
| K06 全部等待者取消 | ✔ 有界结束，无悬挂 Entry，不误停 |
| K07 创建失败后重试 | ✔ 可成功，无 rejected Promise 缓存 |
| K08 旧 finally 与新重试交错 | ✔ 旧 finally 删不到新 Entry |
| K09 名称冲突后发现匹配运行容器 | ✔ 复用，无 rm -f |
| K10 同名不同配置/非本项目容器 | ✔ 显式冲突，不删除 |
| K11 两进程同时初始化 | ✔ 数据目录维护锁+归属检查，互不删除（真实 Docker 另见 D03x） |
| K12 浏览器首次 launch 并发 | ✔ 源码级回归（promise 合并+会话按键隔离）；行为级在 D04 |

## H03 租约围栏（tests/storage/lease-fencing.test.ts, worker-fence.test.ts）

| ID | 结果 |
| --- | --- |
| L01/L02 接管后旧 owner claim execute/decide | ✔ 拒绝，不建 Run，记 run.lease_rejected |
| L03 旧 Controller heartbeat | ✔ 更新数=0；Engine 停止补充并取消本地 Run |
| L04 同 owner 过期后重取 | ✔ generation 递增，旧 Lease 无效 |
| L05 release 后再 acquire | ✔ generation 不复位（行保留置过期） |
| L06 旧 finally release | ✔ 不释放新 generation |
| L07 到期 Run heartbeat | ✔ 不复活不延长 |
| L08 容量 1 回收后新 Run，再旧 heartbeat | ✔ 有效活跃 Run 不变 2 |
| L09 Controller 先过期 Run 未到期 | ✔ 模型与 env 发送均拒绝（controller_lost），发送次数=0 |
| L10 旧 Lease 直写 Storage | ✔ 表驱动覆盖 observation/fact/finding/propose_step/propose_plan/checkpoint/finish 全部拒绝 |
| L11 旧 Lease finishRun | ✔ 不改新 Step、不动新 active_run_id |
| L12 合法 finish 重复提交 | ✔ 幂等（F09 亦覆盖） |
| L13 双连接同时 claim 同 Step | ✔ CAS 唯一胜者（T28） |
| L14 双连接容量边界/Decide-Execute 竞争 | ✔ 不超上限、不重叠、无半写 |
| L15 now == deadline | ✔ 全路径统一视为到期 |
| L16 陈旧 heartbeat | ✔ 不缩短新 deadline |
| L17 失效 Run 有未知外部调用 | ✔ 保留恢复占槽，冲突 Step 不重启（recovery_pending） |
| L18 Worker Promise 抛错 | ✔ 内存清理，持久 Run 可回收（runLoop 每周期 recoverStaleRuns） |
| L19 旧数据 Run 缺 generation | ✔ 不匹配任何当前代数 |
| L20 事务验权失败/写入抛错 | ✔ 无半写实体（L14 断言 run 行数不变） |

## H04 恢复（tests/gateway/recovery.test.ts, tests/kali/isolation.test.ts, tests/kali/exec-record.test.ts；T25–T32 子进程崩溃保留）

| ID | 结果 |
| --- | --- |
| E01 效果已发生、无回执 | ✔ 持久句柄找回，reconciled，不重发 |
| E02 无回执连续恢复 10 次 | ✔ 仍 unknown，锁/责任/占槽不被次数释放，事件去重 |
| E03 permit 事务提交前终止 | ✔ 无效果无半预留，可重新准入（T26 子进程崩溃路径） |
| E04 permit 提交后适配器未调 | ✔ 无正向未执行证据→保持 uncertain |
| E05 效果后、external_id 写入前终止 | ✔ 依预存 handle 找回（isolation 新用例） |
| E06 afterSend 后、结算前终止 | ✔ 重启只结算一次 |
| E07 两个恢复者竞争同一终结 | ✔ 幂等键阻止双结算 |
| E08 终结后旧回调返回 | ✔ 只注释归档，预算不变 |
| E09 查询超时/损坏回执/容器缺失 | ✔ 保持 unknown（含 corrupt record） |
| E10 可靠 not_started 且发送权已撤 | ✔ 释放，可由新决策重试 |
| E11 失败前已发生部分效果 | ✔ failed_known 保留 effect:possible |
| E12 模型断连缺 usage | ✔ 按预留保守入账，不按零 |
| E13 同 invocation 并发/重启重发文件适配器 | ✔ 实际效果只一次 |
| E14 非幂等适配器未知结果 | ✔ 自动重试次数=0 |
| E15 前台/后台 Kali 分别崩溃 | ✔ 两类都有持久执行记录可查（重启后新 Runtime 读得到） |
| E16 PID/容器名复用 | ✔ 身份不符不发信号 |
| E17 取消宿主 docker CLI | ✔ 探容器进程组，未确认前不解锁；真实 Docker D05 复核 |
| E18 结算 calls/tokens/cost | ✔ 幂等且守恒（E01/E06 断言） |
| E19 未解决调用普通收口 | ✔ 阻塞并列出 invocation id |
| E20 受信人工裁决 | ✔ 记录 Actor/依据/原状态；acknowledged_unknown 不写成未发送 |

## H05 配置贯通（tests/contract/runtime-config.test.ts）

| ID | 结果 |
| --- | --- |
| U01 旧 Spec/CLI 无 workers | ✔ 请求=1，行为兼容 |
| U02 请求 2、宿主 2 实际重叠 | ✔ tests/p1/parallel-execute.test.ts M01+M03+M10（引擎级真重叠，门卡为证） |
| U03 请求 2、宿主 1 | ✔ 生效=1，投影显示宿主限制 |
| U04 创建后重启进程 start | ✔ 持久化请求值仍 2 |
| U05 Web 创建 2 + 运行配置 2 | ✔ EngineHost 实际得 2（runtime.json 驱动），创建接受 workers |
| U06 Web 服务重启 | ✔ 运行配置按规则恢复 |
| U07 Contest slots 与 workers 区分 | ✔ workers 落进每题 spec，共享进程信号量 |
| U08 flags/env/file/default 优先级 | ✔ 唯一顺序 |
| U09 workers 非法 | ✔ CLI/API/Spec 同一错误语义 |
| U10 运行上限非法/配置损坏 | ✔ 启动失败，无部分创建 |
| U11 运行中改 workers | ✔ 拒绝；暂停后更新+事件 |
| U12 不支持命令传 workers | ✔ CLI 显式拒绝；模型工具无此入口 |

## H06 真实 Docker 与发布门槛

| ID | 结果 |
| --- | --- |
| D01 全新库/v4/v5 迁移 | ✔ tests/storage/migration-v6.test.ts（首开即 v6、可重入、过新拒绝） |
| D02 迁移中断重试 | ✔ 同上 |
| D03 真 Docker 连续冷启动两个 Worker | ✔ tests/docker-acceptance.mjs：1 次创建、双 exec 成功、同名单容器 |
| D03x 两 OS 进程同名竞争 | ✔ 退出码 0,0；容器恰一个（跨进程维护锁+冲突复用） |
| D04 双 Run 浏览+截图隔离 | ◐ 环境跳过：本机 Docker 不解析 host.docker.internal（无容器到宿主路由）；会话/目录隔离由 K12、E15 与既有 C4 隔离测试覆盖 |
| D05 单 Run 取消、同伴继续 | ✔ 真实容器：取消方进程组经 environ 标记探明并 kill，ps 复核已消失，同伴 exec code=0；记录 cancel_confirmed=true |
| D06 杀进程后新 Controller 接管 | ✔ 存储/网关层覆盖（L09、L03、T25–T27 子进程崩溃）；无额外真实容器用例 |
| D07 新输入到达且 Execute 活跃 | ✔ 停止 refill、排空后仅一个 Decide（tests/p1/scheduling.test.ts 既有边界语义回归通过） |
| D08 同预算单双 Worker 配对 | ✗ 未跑：无真实模型凭据；docs/multiworker-benchmark.md 只记 harness 与指标，不填假数字 |
| D09 assessment 与 CTF 完整路径 | ✔ 既有 e2e（protocol、p2、contest runner、web api）全绿，互不改变完成判据/预算/能力 |
| D10 单 Worker 关闭并行演练 | ✔ 默认 1 全量回归通过；旧任务可读可续跑（F24 升级用例） |
