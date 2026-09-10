# RioNext 操作指南

RioNext 是本地 Decide/Execute 控制器。Decide 串行规划，Execute 一次认领一个 step，Kali 工具跑在战役容器里。状态在 SQLite 和产物目录，不在模型会话里。改源码不会热加载正在跑的 Node 进程。同一战役不要开第二个 Engine。

默认数据目录是仓库下的 `.rionext/`（可用 `--data-dir` 或 `RIONEXT_DATA` 改）。密钥只放 `.rionext/provider-secrets.json`，不要提交。

Windows 用仓库里的 `.\rionext.cmd`。Linux/macOS 用 `./rionext` 或 `npx rionext`。下面命令以 Windows 为例。命令一览：`.\rionext.cmd ?`，`.\rionext.cmd ? provider`，`.\rionext.cmd ? kali`。

需要 Node >= 22.19.0。先 `npm install`，再 `npx tsc -p tsconfig.json`，CLI 读的是 `dist/`。

## 一次健康检查

```
.\rionext.cmd health
.\rionext.cmd kali status
```

`health` 看 Docker 和 Kali master 镜像在不在。`kali status` 会打印 `rionext-kali:rolling` / `:master` 和 keeper 容器。

## Kali 镜像（只建一次）

战役容器从 master clone，取消战役时 `docker rm` 克隆，**不要** `docker rmi` master。镜像大约 12.9GB，坏了再重建。

第一次：

```
.\rionext.cmd kali pull
.\rionext.cmd kali build
.\rionext.cmd kali protect
.\rionext.cmd kali smoke
```

`protect` 钉住 keeper，防止 `docker system prune -a` 把 master 清掉。entrypoint 脚本改了不必重建镜像，host 会把 `docker/kali/entrypoint.sh` bind-mount 进克隆。

## 接入模型

密钥进 `.rionext/provider-secrets.json`，不进 git，CLI 也不会打印。网页 `provider ui` 是可选的本地页，和 CLI 同一套 catalog。

```
.\rionext.cmd provider add --name "OpenCode Go" --protocol OPENAI_CHAT_COMPLETIONS --base-url https://opencode.ai/zen/go/v1/chat/completions --api-key <KEY>
.\rionext.cmd provider model add --provider prv_... --name deepseek-v4-flash --context 1000000 --max-output 51200
.\rionext.cmd provider test --provider prv_... --model deepseek-v4-flash
.\rionext.cmd provider slots --solver mdl_...
.\rionext.cmd provider key --provider prv_... --api-key <NEW_KEY>
.\rionext.cmd provider show prv_...
.\rionext.cmd provider list
.\rionext.cmd provider help
```

换 key 用 `provider key`，不用再 add 一家。`provider set --provider prv_... --api-key ...` 也能改名、协议、地址。`provider rm` 删供应商、模型和 key。`slots --solver` 指定主求解。空槽回落到 solver。`.\rionext.cmd provider ui --port 7780` 仍可用，不是另一套系统。

OpenCode Go（`opencode.ai`）请求会自动带 `x-opencode-session`（战役用 campaign_id，探测用 provider id）和 `User-Agent: rionext/0.1.0`。其他供应商不加这个头。

战役 spec 里的 `model_policy.provider` 用 `prv_...` id，`model` 用模型名。`thinking_level` 默认 `high`。流式超时默认 600 秒。

## 战役 spec

合成环境示例：`profiles/demo-lab.json`（scripted，不打网）。Kali 实靶把 `execution_profile` 设成 `kali`，`scope.assets` 写主机名和入口 URL，`tool_allowlist` 带上 `kali_run` / `kali_write` / `playwright`。

最低要有：

- `campaign_id`，`schema_version: 1`
- `mode`: `goal_seeking` 或 `assessment`
- `root_goal.statement` 和 `success_predicate_ref`（找 flag 用 `flag_recovered`）
- `budget`：至少 `max_calls` / `max_tokens` / `max_cost_micro` 之一。省略键时默认 3000 calls、30_000_000 tokens
- `model_policy`、`scope.assets`、`tool_allowlist`

实靶资产必须能过出口白名单。主机名和 `http://host/` 都写上。容器 iptables 按解析出的 IP 放行。

## 开跑

实靶找 flag，一条命令就行，不用先写 spec。模型用 catalog 里的 solver 槽：

```
.\rionext.cmd run --url http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/
.\rionext.cmd http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/
```

会生成 Kali `goal_seeking` 战役：入口 URL 进 scope，成功条件 `flag_recovered`，thinking `max`。同一 URL 再跑会接着已有 id。`--id` 可改战役名。`--url` 和 `--spec` 不能一起用。没有可用模型时先 `provider slots --solver mdl_...`。

仍可用文件：

```
.\rionext.cmd run --spec path\to\spec.json --progress-ms 60000
```

已存在同 id 就接着跑。`--progress-ms` 默认 5 分钟打一次预算和最近调用，`0` 关掉，`--json` 不打进度。`--max-cycles` 默认 1000（控制器循环，不是模型调用）。单个 Execute 片段默认 72 轮模型、144 次工具；`--max-execute-turns` / `--max-tool-calls` 可改。到上限还没 `finish_step` 才进 Finalize。

只创建不跑：`.\rionext.cmd create --url ...` 或 `--spec ...`。恢复：`.\rionext.cmd start <id>`。

同一 `campaign_id` 不要再开一个 `start`/`run`。控制器锁会拒绝，硬开第二个进程会抢库。

改完 TypeScript 必须重新 `npx tsc -p tsconfig.json` 再 `start`。正在跑的进程用的还是旧 `dist`。

## 工作台 UI（ui 服务器）

`.\rionext.cmd ui --port 7780` 拉起的不是只读面板：UI 里 start 的战役作为该进程内的异步 Engine 任务在跑，和 CLI 用同一套 `controller_locks`。因此：

- **同一战役勿双 start。** ui 进程内在跑的战役，CLI 再 `start` 会被锁拒（`controller_lock_held`，报错里带 owner）；反过来也一样。ui 自己重复 start 返回 409 `already_running`。
- **ui 进程重启 = 控制器崩溃恢复。** 重启后首个 `start`/`resume` 走 `recoverStaleRuns`：过期租约被接管，跑到一半的 Execute 片段标 `uncertain`，先 `reconcile` 再续跑。UI 详情页时间线上 uncertain 的 bar 点了就能 reconcile。
- **关 ui 不会清战场。** 进程退出不 cancel 战役；战役容器还在，锁租约（60 分钟）到期前别的进程接不走，要么回 ui 里 pause/cancel，要么等租约过期。
- **上传暂存在数据目录。** 向导传的附件放 `.rionext/uploads/<id>/`，triage 只做确定性判定（magic bytes / ELF / ZIP 清单），不执行样本。删除战役不会清 uploads，自己删目录即可。
- **Kali 长操作是子进程任务。** 基础设施页的 pull/build/protect/smoke 在 ui 里 spawn 子 CLI 跑（不阻塞事件循环），日志在任务卡片里轮询；同一时刻同类操作防重入。
- **health 有 3 秒缓存。** 顶栏 chip 每 5 秒打一次 `/api/health`，docker inspect 最坏会卡几秒，缓存是为了不拖慢整页。
- **备份恢复走 API 也行。** 设置页 backup 默认落到 `.rionext/backups/backup-<时间戳>`；restore 会覆盖当前数据目录，按钮带二次确认，等价 `rionext restore --from ...`。

`provider ui` 旧命令不受影响，仍是那个只管 catalog 的本地页。

## 人审 flag

`goal_seeking` 且 `success_predicate_ref` 不是合成 `sample_recovered` 时，模型交 `flag_recovered` 会停在 `awaiting_verify`，不会自己标完成。

```
.\rionext.cmd status <id>
.\rionext.cmd accept <id>
.\rionext.cmd reject <id> --text "这个 flag 不对，因为..." --continue
```

`accept` 才关战役。`reject` 把原因写进上下文。`--continue` 会立刻再 `start`。

## 过程中

```
.\rionext.cmd list
.\rionext.cmd status <id>
.\rionext.cmd steps <id>
.\rionext.cmd facts <id>
.\rionext.cmd findings <id>
.\rionext.cmd events <id>
.\rionext.cmd operations <id>
.\rionext.cmd report <id>
.\rionext.cmd hint <id> --text "不要再用容器 php 当 unserialize 预言机"
.\rionext.cmd pause <id>
.\rionext.cmd resume <id>
.\rionext.cmd cancel <id>
```

`cancel` 停战役容器（`docker rm` 克隆），不删 master。已经发出的包收不回来。

改预算：`.\rionext.cmd revise-budget <id> --max-calls 1000 --max-tokens 10000000`。

备份：`.\rionext.cmd backup --out path\to\dir`。

## Execute 收卷（Finalize）

默认 `finalization.enabled=true`：Execute 自然停笔、turn cap、普通 tool cap 且 Primary 没交合法 `finish_step` 时，再打一轮只含 `finish_step` 的 Finalize（最多一次，thinking low，max_output_tokens 12800，强制 `tool_choice=finish_step`）。Primary 已经合法交卷则不跑 Finalize。`error` / 取消 / 过期 deadline / stale fence / 未知外部效果 / 预算不足不会走语义成功。

`deferred` 带 `next_action` 且没给 `reopen_rule` 时默认 `{kind:"always"}`，下一个调度周期会再派发（同一 Run 内不递归，最多 5 次 Execute）。没有 `next_action` 的 `deferred`、以及没给规则的 `blocked`，默认 `{kind:"never"}`。显式 `reopen_rule` 优先。

关闭：

```
.\rionext.cmd run --spec path\to\spec.json --no-finalization
```

或环境变量 `RIONEXT_FINALIZATION=0`。关闭后，没交 `finish_step` 就 `incomplete_protocol`，不会自动 `resolved`。`--finalization` 和 `RIONEXT_FINALIZATION=1` 仍可强制打开。两个 CLI 开关不能一起用。不要靠改提示词代替这个开关。

`status` 会打 主动交卷率、补交成功率、最终协议完整率（由 `run.finish_submitted` / `run.finalization_started` 等事件计算）。

## 预算和租约

默认 1000 次调用、1000 万 tokens。模型发送和工具调用各算 1 次调用。Execute 租约 60 分钟。high thinking 单次流式最多约 600 秒，一个片段里多轮模型+Kali 要能在租约内结束。

kali_run 回模型的 stdout 预览 50000 字节。`truncated=true` 时用返回的 `artifact_id` 和 `next_offset` 调 `artifact_read`，直到 `truncated=false`。上下文包带最近 20 条 observation。更早的用 `graph_query entity=observations`（默认从最早开始，`offset` 翻页，`order=desc` 从最新开始）。

## Kali 工具习惯

白名单二进制。`bash`/`sh`/`python3` 可以 `-c` 或跑 `/workspace` 下的脚本。`curl` 参数里不能有 `&` `$` `;` 这类元字符。带 query string 的 URL 用 `bash -c 'curl ...'`，或先 `kali_write` 再跑脚本。

nmap/nuclei/katana 等扫描会立刻返回 `execution_id`，在容器里继续跑（最长 60 分钟）。不要轮询。保存后 `finish_step`。扫描占用 workspace 锁，结束前别指望并行 curl。

每个 Execute 片段必须 `finish_step`。只 `checkpoint` 不会交还槽位。

活靶 PHP 和容器 PHP 不是同一个。unserialize / 长度 / 正则以活靶 HTTP 为准。

## 常见卡死

- **另一个控制器占着锁。** 不要对同一 id 再 `start`。进程已经死了可以等租约过期，或清 `.rionext/rionext.sqlite` 里该战役的 `controller_locks`。
- **resource_locked。** 非法参数、出口拒绝、镜像缺失现在会放锁。后台扫描仍会占锁直到扫完。
- **源码改了战役没变。** 没重新编译，或没停掉旧进程。
- **DNS。** 网关用系统 `lookup`，失败再 `docker getent`。不要依赖 c-ares `resolve4`（Windows 上 VMware 校园 DNS 会 REFUSED）。

## 合成环境冒烟

不配密钥、不启 Kali 也可以：

```
npm test
.\rionext.cmd run --spec profiles\demo-lab.json
```

scripted 策略会走完实验室柜子。这只验证协议，不是实靶。
