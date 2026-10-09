# Cairn 对齐实施记录（2026-10-09）

按《RioNext 向 Cairn 靠拢：完整开发规格 v1.0》执行。基线 main@7bad42e。

## 完成的提交

| 提交 | 内容 |
| --- | --- |
| f5afcff | 工具能力按任务组合（ctf/web capability resolver 进 Engine→KaliRuntime 生产路径）；challenge.web_url 全链路往返（解析、校验、scope 一致性、重启/重开不丢） |
| 1b9e40c | 通用 decide/execute prompt 与领域资料分离；briefs/（ctf、web、assessment）+ env-kali.txt 按契约字段组合；skills 从固定流程改为参考；纯 Web 组合 prompt 有新 golden |
| 1ff32f0 | 模型视图投影（model-view.ts）：活动优先、known/hypothesis/disputed/stale 映射、真实省略计数、graph_query ids 详读、recent_results、控制字段不再进模型 payload |
| ce752a1 | 及时 Decide：去掉 ready 抑制；H 水位（reviewed_seq 只确认到 manifest 快照）；失败去重记运行前水位；no_change 不空耗空复核额度；pending_decision 取代审计事件计数；tool_raw 不再单独请求复核 |
| 0a1dff0 | 接口瘦身：propose_step 最小输入只有 question；fingerprint 程序生成且旧默认可合并；expected_revision 由内部 read set 填充，没读过的实体拒绝调整 |
| 4f3d9d1 | 验证策略生效：goalFactCanSatisfy 统一根目标判定；定向 verification_result（目标声明、证据存在、环境新鲜、confirmed 需本 run 证据）；删除"resolved+有 artifact 就批量确认"；Finalize 不能首次下结论 |
| 478bb2d | 交付要求显式化：require_confirmed_findings / require_complete 解析持久化并进入完成判定；覆盖结论只走 assessment 的显式 coverage_result；F36 改测新语义 |

## 行为变化摘要

- 混合任务（附件+live Web/TCP）：工具按能力组合可用，web_url 创建/重启/备份全链路保留。
- 提示：通用任务不再有 flag/PHP 等全局指令；纯 Web CTF 组合 prompt 有 golden；skill 全部改为参考语义。
- 图视野：活动项优先，省略数量真实，无伪造 offset；大输出不再挤掉图。
- 调度：有待复核输入时 ready step 不再挡 Decide；水位不吞运行期间的新输入。
- 验证：观察/推断/独立验收在完成状态和报告中明确区分。

## 自动测试

- 命令：`npm test`（tsc + node --test）、`npm run build`（含 vite）。
- 结果：379 测试通过、0 失败、2 跳过（既定跳过）。新增测试文件：model-view、scheduling、step-interface、targeted-verdict、completion-policy、contest/runner，以及 run-input/allowlist/web-golden 等的行为更新。
- Docker smoke：未跑（无真实 Docker 守护进程参与本次开发）。

## 真实模型对照

未执行。本仓库当前没有配置真实供应商凭据，全部验证基于 scripted stream、fault 注入、SQLite 持久化与假 Docker。按规格 §14，精简前后的配对成功率、token/耗时对照尚未测量；不能把本地通过写成渗透成功率已验证。

## 已知限制

- graph_query 的 ids 详读走实时行，不是历史 MVCC 快照。
- 120k 图软预算是工程起点，未按任务规模自适应。
- 比赛督导（contest）保持外围方式，未并入内核。
- 供应商协议、默认预算、Finalize token 上限未动（按规格要求）。

## 回滚

按提交逐个 `git revert` 即可；无存储 schema 变更，旧数据库可读。
