# Contest 模式实施计划（春秋 AI 智能体解题赛）

2026-09-10 定稿。目标：接入比赛 API，一个督导进程最多并行 4 个独立战役，
共享 1 个 Kali 容器，自动提交 flag、判错续跑、判对放槽。普通模式零回归。

## 0. 接口契约（PDF + 2026-09-10 实测）

三个接口均为 HTTPS GET、参数全在 query、HTTP 状态几乎恒 200，业务对错看 JSON：

| 用途 | 路径 |
| --- | --- |
| 查题 | `/04cb510e425bd8f64fa97ba66f3935e1?token=` |
| 重置 | `/deed3dba39e57b7cf95ea63ddd84e0c8?token=&question_id=` |
| 提交 | `/ff874ef3172cbf4fd6ec2c5653a568e2?token=&question_id=&answer=` |

实测增补（PDF 没有）：

- **必须带浏览器 UA**。curl 默认 UA 被知道创宇 WAF 拦：HTTP 403 HTML
  （`Knownsec CloudWAF` / `__jsluid_s`）。WAF 页不是 JSON，归类为基础设施故障，
  退避重试，**绝不当错 flag**。
- 只认 query。请求头/POST 无效；`Token=` 大写等于没传；多余 query 被忽略（容错利好）。
- 提交参数名 `answer` 已实测确认（`flag=`/`Answer=` 都回「提交的内容不能为空」）。
  但三参数齐全仍回「缺少参数」——可能有第四个未写明的必填参数，或测试赛提交半残。
  正式赛用真 token 首交时观察文案再定。
- 限流：连续十几次请求回 `对不起，您的操作太过频繁！`，约 40 秒恢复。重置接口更紧。
  轮询 3s/15s 安全；提交/重置不得与轮询同秒爆发。
- 错误全是 `code:101`。已知 message 分类：

| message | 归类 | 督导动作 |
| --- | --- | --- |
| `查询成功`/`操作成功`/`答案正确`(+`status:1`) | 成功 | 走对应成功路径 |
| `对不起，您的操作太过频繁！` | 限流 | 退避 ≥40s 重试，不算错答 |
| `提交的内容不能为空` | 参数问题 | 配置错误，不驳回战役，告警 |
| `缺少参数`（提交时） | 疑似第四参数缺失 | 同上，不驳回，告警 |
| `缺少参数`（查题时） | token 未传 | 告警并继续轮询 |
| `暂无队伍信息` / `比赛ID错误` | token 未生效/未注册 | 继续轮询（赛前可能未开放），日志节流 |
| `miss route` | 路径/方法错 | 配置错误，告警 |
| 其他 `code!=0`（提交时） | **错答** | rejectGoalClaim + 续跑 |
| 非 JSON / WAF HTML | 基础设施 | 退避重试 |

信封与题目字段按松 JSON 解析：多字段留 raw、缺字段不崩、单行解析失败丢该行。
`interactive` 是字符串 `"true"/"false"`（容忍布尔）；`connection` 静态题 `[]`、
容器题对象（`docker_url`/`docker_ip`/`docker_port`，可缺）；`file_url` `""`≈无附件。

## 1. 总体架构

```
rionext contest run --mode test|official --token-file t.txt [--slots 4]
  └─ ContestSupervisor（单进程，确定性代码，不是第五个求解 LLM）
       ├─ ContestApi          查题/提交/重置，松解析，UA，退避
       ├─ 选题（纯函数）       mock 过滤 → 分层 → real_score 升序 → solved_number 降序
       ├─ 槽位 ×4             每槽一题：prepare → Engine.start → 停 awaiting_verify
       │    └─ EngineRunnerFactory   每战役独立 Engine（EngineHost 已验证形态）
       │         └─ 共享 Kali 容器 ×1（见 §3）
       ├─ 提交队列（串行）     间隔 ≥5s；限流退避 40s；判对 accept+放槽；判错 reject+续跑
       ├─ manager 反应 LLM    仅判错后一枪（manager 槽，无工具，一次 JSON）
       └─ 状态文件/STOP 文件   contest status / contest stop / contest reset
```

- 数据目录：`<base>/contest/`（独立 sqlite，不污染 `rionext list`）；
  启动时把 `providers.json` / `provider-secrets.json` 从主目录拷入（缺才拷）。
- 战役 id：`camp_q_<question_id>`（清洗、≤48 字符），重复轮询不重开。
- 一题一槽；崩溃原 data-dir 续跑，连崩 3 次隔离；错答 3 次暂停让槽。

### 题目 → 战役映射（平台 category 优先于文件魔数）

| 形态 | 入口 |
| --- | --- |
| `web` + `connection.docker_url`（`host:80` 或 URL） | `specFromUrl(http://host/)` |
| 有 `file_url`（±endpoint） | 督导下载附件 + 写 brief.txt → `specFromInput(目录)` |
| pwn 有 `docker_ip/docker_port` 或 `nc ip port` | endpoint `tcp://ip:port` 进 scope.assets |
| 只有 description | 写 synthetic brief.txt 当附件题 |
| 无入口（无 URL/附件/ip:port/描述） | 不占槽，等下轮列表补全 |

kind 覆盖策略：`pwn/reverse/crypto` 用平台 category 覆盖分类器；`misc/generic`
交给分类器（保住 protocol/stego 等 overlay）；web 永远走 --url。

## 2. 判对放槽 / 判错续跑（核心闭环）

```
Execute submit_fact(flag_recovered) → 战役停 awaiting_verify → Engine.start 返回
  → 督导 pendingGoalClaim 取 proposition → extractFlag（flag{}/CTF{} 正则，兜底全文）
  → 已拒集合查重（重复值本地驳回，不浪费平台提交）
  → 串行提交队列 → 平台
     ├─ 对：verifyGoal(accept) → completed → 清 workspace → 放槽 → 按榜补下一题
     ├─ 限流/参数/平台故障：不驳回、不计数，退避重试
     └─ 错：rejectGoalClaim("Contest platform judged this flag incorrect (n/3). Platform message: …")
            （走 StorageService 直调，actor={kind:"controller",id:"contest"}，中性文案）
            → manager 槽一枪（可选）→ persistHint("[manager] …")
            → manager 说 reset 且容器题 → 平台重置 → 下轮轮询对比 connection，变了改 scope
            → n≥3：pause + 隔离 + 放槽；否则 Engine.start 续跑
```

- 错答的持久记录 = facts 表里的 disputed 事实（rejectGoalClaim 现成行为）+ hint。
- 平台侧 `is_solved` 翻 true（别人先解）→ 取消本地战役、放槽。
- `connection` 快照对比变了 → 改写 `spec.scope.assets/entries`（SQL 直改，仿
  persistReviseBudget）+ hint + 共享容器白名单重放。

## 3. 共享 Kali 容器（用户拍板：一容器四 worker）

动机：4 容器 = 4 份 chromium 守护进程，白占 1.5~2GB 内存。

设计（关键：宿主机侧路径零改动）：

- 共享容器 `rionext-kali-contest` 挂载 `<contestDir>/workspace`（父目录）→ `/workspace`。
  战役 A 的容器内根 = `/workspace/<campaignIdA>`，对应宿主机路径仍是
  `<contestDir>/workspace/<campaignIdA>`——ArtifactStore、`.rionext-ops` 后台文件、
  kali_write、stageInput 等宿主机侧代码全部不变。
- `KaliStartOpts` 新增 `shared?: { name, mountHost, containerRoot }` 与
  `limits?: { memory, cpus }`；`buildContainerSpec`/`exec -w`/`opFiles` 容器路径经
  containerRoot 前缀。`EngineOptions.kaliShared` 注入，engine.kaliOpts 按战役拼
  `/workspace/<campaignId>`。
- quick-spec statement 与 run-spec 种子步的 `/workspace/...` 字符串加
  `containerRoot` 参数（默认 `/workspace`，正常模式字节不变；execute.txt 不碰）。
- 出网隔离真相（实测代码后确认）：容器 `cap-drop ALL` 且无 `NET_ADMIN`，
  entrypoint 的 iptables 全部 `|| true` 静默失败——容器级白名单历来是摆设，
  真正拦截一直在宿主机侧 `admitNet`（逐战役、exec 前）。共享容器后**逐战役准入
  完全不变**，iptables 改为督导按在跑题目资产并集 best-effort 重放。
- 生命周期：单战役"清理"= 删自己的 workspace 子目录（宿主机 rm），不杀容器；
  容器由督导统一 ensure/扩限额（默认 memory×4、cpus×4，可配）/`contest stop` 时杀。
- 让步（已确认）：一船命（容器挂则四战役按崩溃续跑）；pw-daemon 共用（pw-ctl
  每次 exec 独立请求，并发安全，实现时实测两道 web 题同开浏览器）。

## 4. 模块清单

新增：

- `src/contest/api.ts` — ContestApi：UA、WAF/限流/参数错误分类、松解析、退避、
  token/flag 不落日志、路径与 answer 参数名可 env 覆盖
- `src/contest/plan.ts` — 纯函数：isMockQuestion / kindForCategory / rankQuestions /
  planFor / endpointFor / webUrlFor / extractFlag / campaignIdFor / scopeFor / connectionKey
- `src/contest/runner.ts` — RunnerFactory 接口 + CampaignHandle 接口 +
  EngineRunnerFactory（下载附件、写 brief、建/续战役、verifyGoal、改 scope、清理）
- `src/contest/shared-kali.ts` — 共享容器 ensure/白名单重放/扩限额/销毁
- `src/contest/manager.ts` — manager 槽一次性反应（无 manager 槽则跳过，模板 hint 兜底）
- `src/contest/supervisor.ts` — 轮询/槽位/提交队列/状态文件/STOP
- `src/cli/contest.ts` — `contest run|status|stop|reset`
- `tests/contest/{api,plan,supervisor}.test.ts` + kali 共享容器单测

改动（全部带默认值，正常模式零回归）：

- `src/tools/kali-runtime.ts` — shared/limits 支持，killName/inspectName
- `src/controller/engine.ts` — EngineOptions.kaliShared → kaliOpts
- `src/domain/quick-spec.ts` / `src/cli/run-spec.ts` — containerRoot 参数
- `src/cli/index.ts` / `src/cli/args.ts` — contest 命令与帮助
- `README.md` — 一节

## 5. 限流与容错默认值

- 轮询：开赛 60s 内 3s，之后 15s；网络/HTTP 错误指数退避封顶 30s；空列表不是失败。
- 提交：全局串行，间隔 ≥5s；限流退避 40s ×最多 8 次；提交与轮询不并行爆发。
- 崩溃：同 data-dir 重开，3 次隔离。错答：3 次暂停让槽。
- token 只从 `--token-file` / `RIONEXT_CONTEST_TOKEN` 读；token 与 flag 不进日志。
- 模式必须显式 `--mode test|official`：test 收 mock/测试题（全链路练放槽与续跑）；
  official 过滤标题/描述/属性命中 `测试|test|mock|sample|样例|练习` 的题。
- 选题确定性排序：L1 静态 web/misc/crypto → L2 容器 web → L3 带附件 misc/crypto →
  L4 其他（pwn/reverse）；层内 real_score(缺→score→9999) 升序，solved_number 降序。

## 6. 验收清单

- 空列表轮询 30s 不退出；题目出现即开战役；mock 过滤按模式生效
- 同时最多 4 战役、**docker ps 只有 1 个 rionext-kali-contest 容器**
- 四战役各自 `/workspace/<campaignId>` 互不串；附件题种子步路径带前缀
- flag 判对 → accept、清 workspace、放槽、补下一题；判错 → reject 文案含平台
  message、同一字符串不再提交、续跑；3 错暂停
- 限流/缺少参数/暂无队伍信息/WAF 页面都不被当成错答
- `contest stop` 后战役 cancelled、共享容器消失；`contest status` 可读
- 普通 `run --url` / `run --input` 行为字节不变；execute.txt 不动；
  `npx tsc -p tsconfig.json` 干净；`npm test` 全绿（含新增 contest/共享容器用例）

## 7. 里程碑

1. api.ts + plan.ts + 单测（纯逻辑，先行）
2. kali-runtime/engine/quick-spec 共享容器支持 + 单测
3. runner.ts + shared-kali.ts + manager.ts
4. supervisor.ts + 单测（假 Runner/假 API 全覆盖核心闭环）
5. CLI + README + 全量测试
