# 多 Worker 实施记录（2026-10-12）

按《RioNext 当前复核与多 Worker 改造方案 v1.0》执行。基线 1e55968。

## 提交

| 提交 | 内容 |
| --- | --- |
| 1ab9ef2 | C0：F01 非法 Finding 转换不再回滚 Run（拒绝事件 + 正常结算）；F02 verification_refs_json 持久化（报告与覆盖关联同时认识原始/验证证据）；F03 覆盖结论必须绑定 step input_refs 声明的义务；F04 graph_query 详情不再剪裁（概览保持紧凑） |
| 57fdc3a | C1：DockerCli.runAsync（spawn、超时、maxBytes、AbortSignal）；KaliRuntime execAsync/playwrightAsync/writeWorkspaceAsync；DispatchGate 拆 permit/afterSend/sendFailed，dispatchAsync 供 Worker 路径；ToolGateway 全异步；AbortSignal 从 Worker 传到 docker 进程。测试证明一个被门卡的 exec 不挡同伴启动与完成 |
| 996d454 | C2：spec.execution_policy.max_execute_workers（1–8，缺省 1=旧行为）；RuntimeConfig.max_concurrent_execute 变整数；claimNextStep 以活 Run 集合容量 + 逐 Step CAS（status+revision+active_run_id）为准，旧 campaigns.execute_* 字段只写不读 |
| 6bd4afd | C3+C4：runLoop 活跃集合调度（边界 Decide、 refill 上限、新输入停补充、首个结算先到先处理）；status 列全部活跃 Run；Run 私有目录（runs/<run_id>）与按 Run 的 kali 结果键；workspace 锁收窄到 Run 级；工具超时不再杀共享容器；pw-daemon 按 session（=run id）分 BrowserContext/page/refs/截图 |
| e8e3b08 | C5：模型调用共享信号量（max_inflight_model_calls 默认 8）；recover 不再把在途模型调用误判 uncertain（孤儿才结算 failed_known）；领取时跳过与运行中 Step 资源冲突的候选；cancel/close 中止全部活跃 Worker；proposeStepDirect 持久化 resource_claims；T14 水位去重标记修正（恒为运行前水位 R） |
| 5082f99 | C6：CLI status 与 Web 详情列出全部活跃 Run；旧 active_run 保留为兼容摘要 |

## 验收覆盖

- 自动测试：npm test 421 通过 / 0 失败 / 2 跳过（基线 379）；npm run build（tsc + vite）通过。
- M01/M02/M10/M12：容量、同 Step CAS、Run 私有目录、资源互斥有测试。
- M03/M04：受控门卡证明真实重叠；C1 另有适配器级证明。
- 并发证明走受控 Promise/双连接/假 Docker；没有真实 Docker smoke。
- 真实模型配对评测未跑（无凭据）：单双 Worker 的成功率、token、耗时差异全部未知，不宣称性能结论。

## 有意未做（本轮）

- Decide 与 Execute 同时运行（边界复核是首版；§6.5 的后续项）。
- 3/4 Worker、读写锁细化、多宿主/消息队列。
- 旧库迁移：无 schema 变更（execution_policy 在 spec_json 内），旧任务默认单 Worker。
- 镜像 digest 固定未变；pw-daemon 改动需在下次镜像重建时带入。

## 回滚

各提交独立；回滚到 1e55968 即回到单 Worker。execution_policy 缺省 1 的旧 spec 行为不变。
