# RioNext mock 前端（四版）

这是给 RioNext 做的静态 mock 前端，全部只读演示：没有后端，数据是按真实 schema 造的假数据，
点任何动作都会弹出对应的 `rionext` CLI 命令，方便评审时对照命令行行为。仓库里的源码一行没改。

打开方式：直接双击 HTML 文件，或 `npx serve mock`。各版互相独立，无共享资源。

| 文件 | 版本 | 设计方向 | 参考产品 |
| --- | --- | --- | --- |
| `v1-war-room.html` | v1 战情室 | 终端风驾驶舱，延续 provider ui 的 patchbay 基因（暗底、琥珀、等宽字），高密度监控面板 | provider ui（仓库自带）、Kali/Zenmap 的工具面板 |
| `v2-graph-workbench.html` | v2 证据图谱 | 浅色工作台，以实体图谱为中心，配时间线、覆盖矩阵、spec 检视器和命令面板 | BloodHound（Sigma.js 图谱）、Langfuse（agent graph / trace） |
| `v3-workspace.html` | v3 战役工作台 | 现代 SaaS 产品风：战役卡片、step 看板、三步创建向导、审查中心、基础设施页 | CTFd 管理面板、NodeZero（向导与实时视图）、LangSmith（监控指标） |
| `v4-graph-workspace.html` | v4 融合版 | v2 的美术风格 × v3 的操作逻辑：左侧导航 + 页面路由 + 三步向导 + 看板，配 v2 的实体图谱（含 inspector）和时间线 | 同 v2/v3 |

## v4 融合版说明

- 外壳：v3 的左侧导航和路由（总览 / 战役 / 审查中心 / 模型目录 / 基础设施 / 设置）。
- 视觉：v2 的浅色纸感、IBM Plex Mono、琥珀 accent、白卡圆角、状态色点。
- 战役详情页签：图谱、时间线（两个视图从 v2 原样搬入，图谱右侧保留 inspector：provenance、fact 就地人审）、看板、观察流、覆盖、事件、报告。
- 三步创建向导（入口与题型 / 模型与预算 / 确认生成）、审查中心、⌘K 命令面板沿用各自来源的逻辑，配色统一到 v2。

## 功能点清单（从源码导出）

1. **健康检查**：docker / Kali master 镜像 / keeper / 数据目录（`src/cli/index.ts` health）。
2. **Kali 镜像管理**：status / pull / build / protect / smoke，master 与克隆的关系，cancel 会 `docker rm` 克隆（`src/cli/kali.ts`、`docs/ops.md`）。
3. **供应商目录**：add / set / key（替换、清除）/ rm，model add / rm（context、max-output、vision），test 探测（auth / text / tools / vision / reasoning + variants），三种协议（`src/cli/providers.ts`、`src/provider/types.ts`）。
4. **槽位路由**：solver / reflect / visual / triage / manager 五槽，空槽回落 solver（`src/provider/router.ts`、`SLOT_LABELS`）。
5. **战役三种入口**：`--url` 活靶 web、`--input` 本地附件（含 `--kind` 覆盖、`--endpoint tcp://`、`--hint`）、`--spec` 文件；`create` 只建不跑；同 URL 续接同 id（`src/cli/run-spec.ts`、`src/domain/quick-spec.ts`）。
6. **确定性 triage**：magic bytes / zip 成员 / PE .NET / ELF 判题，题型 web / reverse（overlay apk、dotnet）/ pwn / misc（overlay protocol、stego、forensics）/ crypto / generic，置信度、证据列表、seed method family、skill pack（`src/domain/challenge-triage.ts`、`challenge-kind.ts`）。
7. **输入暂存**：manifest（路径、sha256、format、executable）、大小与文件数上限、input/original 只读约定（`src/domain/input-manifest.ts`）。
8. **战役生命周期**：11 个状态及迁移（created / active / waiting / blocked / plateau / budget_paused / paused / awaiting_verify / closing / completed / cancelled），start / pause / resume / cancel，控制器锁与租约（`src/domain/types.ts`、`engine.ts`）。
9. **flag 人审**：pending_goal_claim，accept 关战役，reject 写原因回上下文并可 `--continue`（`engine.ts verifyGoal`）。
10. **人工干预**：hint 注入、revise-budget、revise-scope、reconcile（`cli/index.ts`）。
11. **预算**：calls / tokens / cost 三维，free / reserved / liability / spent / overrun，deadline，price_version unknown 时按负债记（`gateway/budget-ledger.ts`、schema `budget_accounts`）。
12. **巡检视图**：list / status / events / steps / facts / findings / observations / invocations / coverage / goals / artifacts / operations / report，全部支持 `--json`（`cli/index.ts`）。
13. **step 细节**：kind 四类、question、preconditions、method_family、attempt_count、blocked_reason、reopen_rule（always / never / fact_key / env_revision / observation_subject）、next_action、explain-step 输出（`storage/service.ts explainStep`）。
14. **Execute 收卷统计**：主动交卷率、补交成功率、最终协议完整率、validation error、conflict，finalization 开关与 `--no-finalization`（`storage/service.ts finalizationStats`、`contracts/finalization.ts`）。
15. **工具面**：graph_query、artifact_read（截断续读）、checkpoint、submit_observation / submit_fact / submit_finding / propose_step、kali_run、kali_write、playwright 十种 op、world_inspect / world_act（合成环境）、finish_step、finish_decision、propose_plan 九种 typed op（`runtime/pi/factory.ts`）。
16. **Kali 执行细节**：按题型白名单（BASE / WEB / BINARY / MISC / CRYPTO）、扫描器后台化返回 execution_id、stdout 预览 50KB 截断、workspace 锁、容器限额、出口白名单与速率（`tools/kali-profile.ts`、`kali-runtime.ts`、`egress.ts`）。
17. **不确定调用**：uncertain 状态、reconcile、residual 可终止清单（`gateway/`、`status` 输出）。
18. **事件流**：21 种事件类型、actor（user / controller / worker / adapter）、correlation（`domain/types.ts EVENT_TYPES`）。
19. **覆盖（assessment）**：obligation、dimensions、applicability / execution_state / outcome / evidence_state 四态、mandatory 与 waiver（`domain/completion.ts`）。
20. **报告**：findings、coverage、cost、unresolved steps、bounded_conclusion（`engine.ts writeReport`）。
21. **运行与运维**：progress-ms、max-cycles、max-execute-turns、max-tool-calls、`--json`、data-dir、backup / restore、合成环境 scripted 冒烟（`cli/index.ts`、`contracts/config.ts`、`docs/ops.md`）。

## 覆盖矩阵

✓ 专属视图承载，◐ 有入口或可见（列表 / 弹层 / 面板），- 未呈现（仅 README 说明理由）。

| 功能点 | v1 战情室 | v2 证据图谱 | v3 战役工作台 | v4 融合版 |
| --- | :-: | :-: | :-: | :-: |
| 1 健康检查 | ✓ 顶栏 | ◐ 状态条 | ✓ 总览条 | ✓ 顶栏 chip |
| 2 Kali 镜像 | ✓ 镜像面板 | ◐ 基建面板 | ✓ 基础设施页 | ✓ 基础设施页 |
| 3 供应商目录 | ✓ 目录面板 | ◐ 模型面板 | ✓ 模型目录页 | ✓ 模型目录页 |
| 4 槽位路由 | ✓ patchbay | ✓ 槽位视图 | ✓ 槽位配线 | ✓ 槽位配线 |
| 5 三种入口 | ✓ run 向导 | ◐ 新建面板 | ✓ 三步向导 | ✓ 三步向导 |
| 6 triage | ✓ 向导内预览 | ✓ spec 检视器 | ✓ 向导第 1 步 | ✓ 向导第 1 步 |
| 7 输入暂存 | ◐ 附件预览 | ✓ spec 检视器 | ✓ 向导第 1 步 | ✓ 向导第 1 步 |
| 8 生命周期 | ✓ 战役列表+操作 | ◐ 头部操作 | ✓ 卡片+看板 | ✓ 卡片+详情工具条 |
| 9 flag 人审 | ✓ 人审卡 | ✓ fact 节点 inspector | ✓ 审查中心 | ✓ 横幅+inspector+审查中心 |
| 10 干预 | ✓ 工具栏 | ✓ 命令面板 | ✓ 战役页 | ✓ 工具条+⌘K 面板 |
| 11 预算 | ✓ 预算仪表 | ✓ 预算条 | ✓ 总览+详情 | ✓ 总览+详情三数字 |
| 12 巡检视图 | ✓ 底部 tabs | ✓ 各视图 | ✓ 详情页 | ✓ 详情页签 |
| 13 step 细节 | ✓ steps 表 | ✓ inspector | ✓ 看板抽屉 | ✓ 看板+inspector |
| 14 收卷统计 | ✓ 右栏 | ✓ spec 检视器 | ✓ 详情页 | ✓ 详情+报告页 |
| 15 工具面 | ✓ 调用流 | ✓ 时间线 | ✓ 观察流+工具徽章 | ✓ inspector 工具面+时间线 |
| 16 Kali 细节 | ✓ ops/residual | ✓ 时间线标注 | ✓ 执行标签页 | ◐ 时间线标注+reconcile |
| 17 uncertain | ✓ 右栏 reconcile | ✓ 时间线高亮 | ✓ 审查横幅 | ✓ reconcile 弹层+红条 |
| 18 事件流 | ✓ events tab | ◐ 图谱边 | ✓ 事件日志页 | ✓ 事件页签 |
| 19 coverage | ✓ coverage tab | ✓ 覆盖矩阵 | ✓ 详情环形图 | ✓ 覆盖页签（环形） |
| 20 报告 | ✓ report tab | ✓ 结论视图 | ✓ 报告页 | ✓ 报告页签 |
| 21 运行与运维 | ✓ 设置面板 | ◐ 命令面板 | ✓ 设置页+备份 | ✓ 设置页+备份 |

v4 相比 v2/v3 少了 v2 的覆盖矩阵视图和 v1 的独立容器操作页签；后台扫描与锁的信息在时间线后台条和 reconcile 弹层里呈现。

三版（四版）故意不做的事：不做持久化（刷新即重置），不做真实请求，不在页面里存任何密钥字段明文（provider key 只显示"已设置"）。

## 假数据怎么造的

战役名沿用 `.rionext/` 里真实跑过的命名（camp_dasctf-http 系列、camp_rev apk 附件、camp_demo_lab 合成），
provider 名沿用 `.rionext/providers.json`（Baidu Qianfan、OpenCode Go、deepseek-v4-flash），但金额、flag、时间全是编的。
