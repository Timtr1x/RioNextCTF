# rionext-kali 镜像构建施工单（CTF 层）

面向接手构建的 agent。读完这份再动手。当前日期 2026-09-10。

## 目标

`docker build` 出含 CTF 工具链的 `rionext-kali:rolling` + `rionext-kali:master`。
Dockerfile 在 `docker/kali/Dockerfile`，CTF 层是最后两个 RUN（install-ctf.sh + verify-ctf-tools.sh）。

## 当前进度

- 第 1–14 步（基础层、Playwright、kali-linux-headless、install-extra.sh 知识库层）**已成功并有构建缓存**，重跑秒过。
- 只剩第 15–17 步：COPY 两个脚本 + RUN install-ctf.sh / verify-ctf-tools.sh。这一层约 10–20 分钟（apt + pip + gem）。

## 构建命令（必须用代理，一次性 --build-arg，不改任何脚本）

宿主机有代理在 127.0.0.1:7890。容器里用 `host.docker.internal:7890` 指回宿主机。
**不要**把代理写进 Dockerfile / package.json / install-*.sh；不要改 `npm run kali:build` 的定义。

```
cd /d/coding/RioNextCTF && docker build \
  --build-arg HTTP_PROXY=http://host.docker.internal:7890 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:7890 \
  --build-arg http_proxy=http://host.docker.internal:7890 \
  --build-arg https_proxy=http://host.docker.internal:7890 \
  --build-arg ALL_PROXY=http://host.docker.internal:7890 \
  -t rionext-kali:rolling -t rionext-kali:master docker/kali
```

预定义代理 ARG 不进缓存 key，所以已缓存层不受影响；代理 env 会注入每个 RUN。

**不要管道**（`2>&1 | tail` 会吃掉 docker 的真实退出码，已经踩过一次假成功）。后台跑、直接看日志文件。

## 已修复的坑（工作区已改完，不用重复处理）

| 问题 | 现象 | 修复 |
|---|---|---|
| `.dockerignore` 白名单漏了新脚本 | `"/verify-ctf-tools.sh": not found` | 已把 `install-ctf.sh`、`verify-ctf-tools.sh` 加进 `docker/kali/.dockerignore` |
| kali-rolling 包改名/下架 | `E: Unable to locate package bkcrack`（以及 p7zip-full、qemu-user-static） | install-ctf.sh：`p7zip-full`→`7zip`，删 `qemu-user-static`（保留 `qemu-user`，提供 qemu-x86_64 等无 -static 后缀二进制），删 `bkcrack`（kali 已下架）。白名单/校验脚本/skill 文本/测试已同步 |
| BuildKit 僵尸顶点去重 | 杀掉 client 后 daemon 侧步骤不死，新构建（带代理）被去重挂到旧的**无代理**执行上，日志时间戳逐秒相同 | 杀所有 `docker.exe` build 进程 + `docker desktop restart` 清掉 in-flight 顶点。再起新构建前先用 PowerShell 确认没有残留的 build 进程：`Get-CimInstance Win32_Process -Filter "Name='docker.exe'" \| Where-Object { $_.CommandLine -like '*build*' }` |
| Python 3.14 轮子：lief | `No matching distribution found for lief`（PyPI 只有轮子没有 sdist，cp314 轮子不存在） | 已从 pip 清单、verify 脚本、kali-profile.ts 删除。lief 的活由 readelf/rabin2/patchelf + pwntools 自带 pyelftools 覆盖 |
| Python 3.14 轮子：ropper | 依赖 filebytes 用 `ast.Str`（3.14 已删除），`Failed to build 'filebytes'` | 已删除 ropper（ROPgadget 覆盖）。引用已清理 |

## 唯一待验证的问题：pwntools 的 unicorn 源码编译

kali-rolling 的 Python 是 3.14.6。pwntools==4.15.0（已是最新版）的依赖约束是
`unicorn!=2.1.3,!=2.1.4,>=2.0.1` —— 恰好排除了唯一有 abi3 轮子的 unicorn 2.1.4，
解析器只能选 2.1.2 的 sdist **源码编译**。unicorn 的 Python 绑定是纯 ctypes，
但 setup.py 要用 cmake+gcc 现场编译 C 核心（约 3–6 分钟）。

install-ctf.sh 的 apt 清单里**已经有** `cmake gcc g++ make`，理论上能编。
已实测确认：angr 9.3.4、fpylll 0.6.4、capstone、z3-solver、pycryptodome 在 3.14 上都有现成轮子；
unicorn 2.1.4 单装有 abi3 轮子（但被 pwntools 排除）。

**验证命令**（一次性容器，不是镜像构建）：

```
docker run --rm -e HTTPS_PROXY=http://host.docker.internal:7890 -e HTTP_PROXY=http://host.docker.internal:7890 \
  --entrypoint bash rionext-kali:master -c \
  "apt-get update -qq && apt-get install -y -qq --no-install-recommends cmake gcc g++ make python3-dev >/dev/null 2>&1 \
   && python3 -m venv /tmp/v && /tmp/v/bin/pip -q install --no-cache-dir --upgrade pip \
   && /tmp/v/bin/pip install --no-cache-dir pwntools==4.15.0 2>&1 | tail -4 \
   && /tmp/v/bin/python -c 'from pwn import *; import unicorn; print(\"PWTOOLS OK, unicorn\", unicorn.__version__)'"
```

- 输出 `PWTOOLS OK` → 直接发起正式构建（上面的构建命令），install-ctf.sh 现状即可。
- 编译失败 → 两个备选：
  a) 接受 pwntools 不带 unicorn：`pip install pwntools==4.15.0 --no-deps` 再手工补依赖（脆，不推荐首选）；
  b) 用 uv 装一个受管的 Python 3.13 进 `/opt`（`curl -LsSf https://astral.sh/uv/install.sh | sh`，`uv python install 3.13`，venv 改用 3.13），cp313 轮子全家都有（lief/ropper 也能复活）。改动集中在 install-ctf.sh 的 venv 段，不动系统 python3。选这个更干净。

## 构建后验收（全过才算完）

```
docker images rionext-kali            # 记录新旧体积（旧约 13.5GB，新增量估计 +2~4GB）
docker run --rm --entrypoint cat rionext-kali:master /opt/rionext/tool-index.json
docker run --rm --entrypoint sh rionext-kali:master -c "gdb --version | head -1 && r2 -v | head -1 && qemu-x86_64 --version | head -1 && ctf-python -c 'from pwn import *; import angr, z3, scapy, Crypto, sympy, gmpy2, fpylll; print(\"ctf-python ok\")' && tshark -v | head -1 && gp --version | head -1 && ROPgadget --version | head -1 && one_gadget --version | head -1"
```

- `tool-index.json` 必须存在且 commands 三组非空（verify-ctf-tools.sh 已保证，缺工具构建会直接失败，到这步基本不会缺）。
- 然后宿主侧：`npx tsc -p tsconfig.json && npm test`（应 281 pass / 0 fail / 2 skipped）。
- 成功后旧 master 被新 tag 覆盖是预期行为；`rionext-master-keep` 容器仍钉着旧镜像 ID，不用动。
- 不要 `docker rmi` 任何 `rionext-kali:*`（README 有保护令：`.\rionext.cmd kali protect`）。

## 网络备忘

- 本机直连 github.com 的 TLS 长传输必断（git clone 8/8 失败的实证），走 7890 代理后 5 个仓库零重试。
- kali.download（apt）和 PyPI 直连可用但慢；构建里全部走代理即可。
- GitHub API 经共享代理 IP 易 403 限流，拉原始文件用 raw.githubusercontent.com。
