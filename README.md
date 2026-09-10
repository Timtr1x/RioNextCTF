# RioNext

本地 Decide/Execute 控制器。Decide 串行规划，Execute 一次认领一个 step，Kali 工具跑在战役容器里。状态在 SQLite 和产物目录，不在模型会话里。

Node >= 22.19.0（开发用 24.12.0）。CLI 读的是 `dist/`。改 TypeScript 之后要 `npx tsc -p tsconfig.json`。

```
npm install
npx tsc -p tsconfig.json
npm test
```

Windows 用 `.\rionext.cmd`。Linux/macOS 用 `./rionext` 或 `npx rionext`。数据目录默认 `.rionext`（`--data-dir` 或 `RIONEXT_DATA`）。

完整操作（租约、锁、Finalize、Kali 镜像）见 [docs/ops.md](docs/ops.md)。命令本身用：

```
.\rionext.cmd ?
.\rionext.cmd ? provider
.\rionext.cmd ? kali
```

## 第一次

```
.\rionext.cmd health
.\rionext.cmd kali pull
.\rionext.cmd kali build
.\rionext.cmd kali protect
.\rionext.cmd kali smoke
```

战役容器从 `rionext-kali:master` clone。`cancel` 会 `docker rm` 克隆，不要 `docker rmi` master。

## 模型

密钥在 `.rionext/provider-secrets.json`，不进 git，CLI 也不会打印。`provider ui` 是可选本地页，和 CLI 同一套 catalog。

```
.\rionext.cmd provider add --name "DeepSeek Direct" --protocol OPENAI_CHAT_COMPLETIONS --base-url https://api.deepseek.com/v1/chat/completions --api-key sk-...
.\rionext.cmd provider model add --provider prv_... --name deepseek-chat --context 1000000 --max-output 51200
.\rionext.cmd provider test --provider prv_... --model deepseek-chat
.\rionext.cmd provider slots --solver mdl_...
.\rionext.cmd provider key --provider prv_... --api-key sk-新key
.\rionext.cmd provider list
.\rionext.cmd provider show prv_...
```

协议：`OPENAI_CHAT_COMPLETIONS`、`OPENAI_RESPONSES`、`ANTHROPIC_MESSAGES`。空槽回落到 solver。`run --url` 用 solver 槽。

## 开打

授权活靶，一条命令，不用写 spec：

```
.\rionext.cmd run --url http://authorized-target.example/
.\rionext.cmd http://authorized-target.example/
```

同一 URL 再跑会接着上次的战役 id。合成环境仍用文件：

```
.\rionext.cmd run --spec profiles/demo-lab.json
```

本地 CTF 附件（Reverse/Pwn/Misc/Crypto）一条命令开打：

```
.\rionext.cmd run --input .\crackme.elf
.\rionext.cmd run --input .\pwn-dir --endpoint tcp://host:31337
.\rionext.cmd run --input .\cipher.txt --kind crypto
.\rionext.cmd run --input .\challenge --hint "题面描述"
```

`--input` 把文件/目录复制进战役工作区（`.rionext/workspace/<id>/input/original`，附 SHA-256 清单），在宿主机做确定性分诊（magic bytes / ELF / PE / ZIP 目录，不执行样本），按题型选二进制白名单，并给 Execute 注入对应的短 skill（`prompts/skills/`）。`--kind auto|reverse|pwn|misc|crypto|generic` 显式覆盖分诊；`--endpoint` 只接受 `tcp://host:port`。`--input` 与 `--url`/`--spec` 互斥。Web 战役的 prompt、工具 schema、白名单逐字节不变（`tests/contract/web-golden.test.ts` 锁定）。CTF 工具链在镜像的独立层，改了要重建：`npm run kali:build`。同一路径再跑会 resume 同一战役；想换 `--kind` 重判就换 `--id` 或删掉旧战役。

`--url` 和 `--spec` 不能一起用。命中 `flag_recovered` 会停在 `awaiting_verify`：

```
.\rionext.cmd list
.\rionext.cmd status
.\rionext.cmd accept
.\rionext.cmd reject --text "flag不正确" --continue
```

只有一个战役时可以省略 id。

## 战役 CLI

```
.\rionext.cmd start [id]
.\rionext.cmd pause|resume|cancel [id]
.\rionext.cmd hint [id] --text "不要用容器 php 当 unserialize 预言机"
.\rionext.cmd facts|steps|findings|events|operations|report [id]
.\rionext.cmd observations|invocations|coverage|goals|artifacts [id]
.\rionext.cmd revise-budget [id] --max-calls 3000 --max-tokens 30000000
.\rionext.cmd explain-step [id] --step step_...
```

`run` / `start` 常用开关：`--progress-ms 60000`（`0` 关掉进度）、`--max-execute-turns 72`、`--max-tool-calls 144`、`--no-finalization`。

默认：一段 Execute 72 轮模型、144 次工具；预算 3000 calls、30_000_000 tokens。Execute Finalize 默认开，Primary 没交 `finish_step` 时补交一次。

同一战役不要再开一个 `start`。正在跑的进程用的还是旧 `dist`。

## 比赛模式（contest）

接春秋 AI 智能体解题赛平台。开赛那天不用守在电脑前手动建战役。一个督导进程盯着平台题单，自动选题、开战役、交 flag，判错了让战役接着打。命令就四条：

```
.\rionext.cmd contest run --mode test --token-file .\token.txt --slots 4
.\rionext.cmd contest status
.\rionext.cmd contest stop
.\rionext.cmd contest reset <question_id> --token-file .\token.txt
```

token 只从 `--token-file` 或 `RIONEXT_CONTEST_TOKEN` 环境变量读，不进命令行参数，也不写日志。

`--mode test` 照收 mock 题和测试题，用来开赛前把全链路演练一遍。`--mode official` 过滤它们，只打真题。这个参数必须显式给，没有默认值，省得到时候手忙脚乱选错。

### 督导怎么干活

开赛头几秒题单一般是空的，平台有时还会先挂几道 mock 题。督导前 60 秒每 3 秒刷一次题单，之后降到 15 秒一次，刷到题就开打。平台返回出错时按指数退避，最长 30 秒。

选题不问模型，照一张写死的排序表来。第一层是不需要连接、不需要附件的静态 web/misc/crypto，第二层是要起容器的 web，第三层是带附件的 misc/crypto，pwn 和 reverse 这些硬骨头垫后。层内按分值从低到高排，同分比解出人数，人多的先打。理由很朴素。开赛抢的是又快又稳的分，让模型自己挑题，它总会被好玩的题勾走。

每道题映射成一个标准 RioNext 战役，id 是 `camp_q_<题目id>`。标题、分类、分值、连接方式、题目描述写进战役的 `brief.txt`，附件由宿主机提前下载好，下载带浏览器 UA，token 不外发。最多 4 个战役并行，`--slots` 可以在 1 到 8 之间调。

4 个战役共用 1 个 Kali 容器 `rionext-kali-contest`，不是一战役一个。容器给 16g 内存和 8 个 CPU，挂载的是比赛工作区的父目录，每个战役在容器里用自己的 `/workspace/<campaignId>` 子目录。有件事要说清楚。容器启动时丢了全部 capability，iptables 规则写不进去，容器内的出站限制从来没真正生效过，真正的闸门一直在宿主机的 admitNet 上。共享容器没有削弱任何实际存在的隔离。

### flag 怎么交

战役觉得自己拿到 flag，就提交 `flag_recovered` 事实进入待审，督导从这一刻接管。

1. 先用正则从战役的报告里抠 flag 值。抠不出来会把报告打回去，让战役只交 flag 字符串本身。
2. 同一个值只交一次。被平台判错的值进黑名单，战役再提同一个值会直接被打回。
3. 提交走全局串行队列，两次之间隔 5 秒。这个平台限速很凶，连发必挨"操作太过频繁"。
4. 判对时战役收口，槽位立刻空出来补下一题，容器里这道题的目录一并清掉。
5. 判错就把平台的原文回复写回战役当提示，附上这是第几次错，战役自动续跑。配了 manager 槽的话，判错后多打一枪诊断，告诉战役别再提交哪个值、下一步是继续打还是重置靶机，外加一段提示。同一道题连错 3 次，战役暂停，题目进隔离名单，槽位让给别人。
6. 限流、WAF 返回的 HTML、"缺少参数"这类平台和配置问题不算错答。等 40 秒重试，不冤枉战役。

如果平台那边显示题已被解出（你手动交了，或者队友从别的路子打了），督导直接取消本地战役，不算失败。

### 容错

平台返回的 JSON 是松动解析的。多出来的字段记一笔日志就放过，缺字段按类型兜底。接口路径和答案参数名都能用环境变量覆盖，平台临时改东西不用动代码。可覆盖的有 `RIONEXT_CONTEST_BASE`、`RIONEXT_CONTEST_LIST_PATH`、`RIONEXT_CONTEST_RESET_PATH`、`RIONEXT_CONTEST_SUBMIT_PATH`、`RIONEXT_CONTEST_ANSWER_PARAM`。

### 赛前检查单

- Kali 镜像得先构建出来，比赛模式不会自己建镜像。
- 拿真 token 第一次提交时盯着点。实测时把文档写的三个参数全带上，平台还是回"缺少参数"，八成有个没写进文档的参数。真碰到了先用 `RIONEXT_CONTEST_ANSWER_PARAM` 换参数名试，不用改代码。
- 平台限速恢复大约 40 秒，督导的退避按这个设。也别连续手动 `contest reset`，一样挨限速。

### 数据在哪

数据在 `<data-dir>/contest/`，独立 sqlite，跟主目录的战役互不影响。跑出来的都是标准 RioNext 战役，但工作台默认看不到它们，比赛模式的交互都在 CLI。`contest status` 读状态文件 `contest-state.json`，能看到 pid、轮询次数、每个槽位在干什么、已解出和已隔离的题目清单。`contest stop` 停督导、取消全部战役、杀共享容器。

接口实测记录、实现计划和验收清单在 [docs/contest-mode.md](docs/contest-mode.md)。

## 工作台 UI

```
npm run build          # tsc + vite，产出 dist/ 与 web/dist/
.\rionext.cmd ui       # http://127.0.0.1:7780（--port 改端口）
```

单进程 = HTTP API + 静态前端 + 战役后台执行：UI 里 `创建并 start` 的战役跑在 ui 进程内（和 CLI 同款 Engine、同一把控制器锁），CLI 那边照样 `list`/`status`/`events` 看得到。绑 127.0.0.1、无认证，只在本地用。

页面：总览 / 战役 / 审查中心（待审 flag 徽标数）/ 模型目录（provider、探测、槽位配线）/ 基础设施（Kali 镜像操作走后台任务日志）/ 设置；战役详情含图谱、时间线、看板、观察、覆盖、事件、报告 7 个页签。顶栏 `＋ 新战役` 是三步向导：`--url` 活靶、`--input` 本地附件（上传后实时 triage 预览题型）、`--spec` JSON。`⌘K` 命令面板里的每条命令都是真执行，toast 回显等效 CLI。

前端轮询（2s）`events?after=seq` 增量，不推流。开发前端用 `npm run web:dev`（vite，proxy `/api`→7780），先另开一个 `ui` 进程当后端。

Pinned Pi packages: [docs/dependency-integrity.md](docs/dependency-integrity.md).
