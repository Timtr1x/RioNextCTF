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

接春秋 AI 智能体解题赛平台：一个督导进程轮询题单，最多并行 4 个独立战役，所有战役共享一个 Kali 容器。

```
.\rionext.cmd contest run --mode test --token-file .\token.txt --slots 4
.\rionext.cmd contest status
.\rionext.cmd contest stop
.\rionext.cmd contest reset <question_id> --token-file .\token.txt
```

- token 只从 `--token-file` 或 `RIONEXT_CONTEST_TOKEN` 读，不进命令行历史。
- `--mode test` 收 mock/测试题（演练全链路），`--mode official` 过滤它们。
- 选题是确定性排序（静态 → 容器 web → 带附件 → pwn/reverse；层内低分优先、解出人多优先），不让模型挑题。
- 战役自己交 `flag_recovered` 后，督导自动提交平台：判对 → 战役收口、放槽、补下一题；判错 → 平台原文写回战役并自动续跑（同一值不再重交，连错 3 次暂停让槽）；限流/平台故障不算错答。配了 manager 槽的话，判错后多一枪诊断提示。
- 数据在 `<data-dir>/contest/`（独立 sqlite），共享容器 `rionext-kali-contest`，`contest stop` 全清。
- 详见 [docs/contest-mode.md](docs/contest-mode.md)（接口契约、容错表、验收清单）。

## 工作台 UI

```
npm run build          # tsc + vite，产出 dist/ 与 web/dist/
.\rionext.cmd ui       # http://127.0.0.1:7780（--port 改端口）
```

单进程 = HTTP API + 静态前端 + 战役后台执行：UI 里 `创建并 start` 的战役跑在 ui 进程内（和 CLI 同款 Engine、同一把控制器锁），CLI 那边照样 `list`/`status`/`events` 看得到。绑 127.0.0.1、无认证，只在本地用。

页面：总览 / 战役 / 审查中心（待审 flag 徽标数）/ 模型目录（provider、探测、槽位配线）/ 基础设施（Kali 镜像操作走后台任务日志）/ 设置；战役详情含图谱、时间线、看板、观察、覆盖、事件、报告 7 个页签。顶栏 `＋ 新战役` 是三步向导：`--url` 活靶、`--input` 本地附件（上传后实时 triage 预览题型）、`--spec` JSON。`⌘K` 命令面板里的每条命令都是真执行，toast 回显等效 CLI。

前端轮询（2s）`events?after=seq` 增量，不推流。开发前端用 `npm run web:dev`（vite，proxy `/api`→7780），先另开一个 `ui` 进程当后端。

Pinned Pi packages: [docs/dependency-integrity.md](docs/dependency-integrity.md).
