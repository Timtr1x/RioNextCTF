# R01–R07 修复实施记录（2026-10-12）

按《RioNext 修复清单与 Cairn 差异说明 v1.1》执行。基线 d36512c（Cairn 对齐完成后的 HEAD）。

## 提交与内容

| 提交 | 修复 | 要点 |
| --- | --- | --- |
| bdc915e | R01 | verdict 按目标类型分派（findings/facts）；input_refs 声明版本比对（target_revision_changed）；严格策略下模型对根目标 flag 的判定不替代外部验收（goal_external_acceptance）；事实证据不可用（retracted/stale/disputed）即拒；applyFactVerdict 是受控 Fact 路径；拒绝全是事件，Run 正常结算 |
| 0292108 | R02 | goalClaimReviewable 统一"是否停靠人审"：只有 goal_seeking+严格策略才停；assessment 匹配事实按普通事实处理；submit_fact 工具文案按策略生成；repairMisParkedAssessment + `rionext repair <id>` 受控恢复误停的旧 assessment（拒绝条件：有在途 Run 或未决外部效果） |
| 62cd8d8 | R03 | coverage_result 需要本 Run 在当前环境的观察证据；旧环境/他人证据拒绝；只在 resolved Run 上应用；confirmed 必须关联同战役已合法 confirmed 且证据有交集的 Finding，覆盖路径不升级 Finding |
| 44bfcd9 | R04 | deliveryGateBlockers 覆盖证据新鲜度（stale/missing 不收口）、inconclusive 不算严格完成、applicability 未决定要显式决定、blocked/in_progress 不算完成；not_applicable/waived 走既有合法路径；closing 的 commitCompletion 本来就以新鲜快照重估，现在自动继承加强后的 gate |
| 592b2dd | R05 | input_refs 按 EntityRef 对象读 id（旧字符串数组兼容可读）；preconditions 按 PredicateExpr 递归 all/any，收 atom.fact_id 与 atom.key；去掉 JSON 文本正则；G03 改对象格式，R05-09 走 proposeStepDirect 生产路径防夹具漂移 |
| 4f09270 | R06 | 活动 step 不再固定 60 条：预算内全展示，超预算先丢旧填充事实再丢低优先级 step 尾部（当前 step 不动），省略计数真实；steps 带 method_family；graph_query 分页全带 revision，Worker 据此记内部 read set，模型拿投影后的业务字段；初始包所有读取收进一个短事务 |
| 8a308ca | R07 | proposeStepDirect/submitFact/submitFinding 加内部 request_review 开关；Decide 批次内的自生成写入不请求复核；外部输入（hint、Execute 片段结束、模型事实）仍推进；水位只确认到 H，中途 hint 不被自己的计划吞掉 |
| 本轮最后一个提交 | 配套 | prompt 加 delivery_requirements（按解析后策略生成，不塞控制面）；报告 findings 的证据引用改可读数组；本文档 |

## 自动检查实跑

- `npm test`：407 通过、0 失败、2 跳过（基线既有）。基线 d36512c 为 379/0/2。
- `npm run build`（tsc + vite）：通过。
- 每个修复先写复现测试再改生产路径；R01-04、R07-01/03 等在修复前会失败。

## 未验收项（如实）

- Docker smoke 未跑：本机开发过程未动用真实 Docker 守护进程；准入路径由假 Docker 记录 argv 验证。
- 真实模型配对评测未跑：无供应商凭据。不能宣称"性能无回归"或"工具已验证"。
- 镜像 digest、配对日志：无。

## 回滚

七个提交各自独立，按需 `git revert`；无 schema 变更，旧库可读。
