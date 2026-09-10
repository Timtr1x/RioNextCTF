# rionext-kali 镜像构建施工单（CTF 层）——已完成

面向接手构建的 agent。当前日期 2026-09-11，**构建已成功收尾**，本文档转为存档 + 重建指南。

## 最终状态（2026-09-11）

- `rionext-kali:master` = `rionext-kali:rolling` = 同一镜像 `8735af706f79`，**16.1GB**（旧镜像 13.5GB，CTF 层增量 +2.6GB）。
- `/opt/rionext/tool-index.json` 存在，commands 三组非空：binary 28 个、crypto 4 个（openssl/john/hashcat/gp）、misc 22 个；python_modules 三组全齐。
- 冒烟全过：gdb 17.2 / radare2 6.0.5 / qemu-x86_64 11.1.0 / ctf-python（pwn+angr+z3+scapy+Crypto+sympy+gmpy2+fpylll 导入 OK）/ TShark 4.6.6 / GP 2.17.4 / ROPgadget 7.7 / OneGadget 2.1.1。
- 宿主侧 `npx tsc -p tsconfig.json` 干净；`npm test` 313 个测试 311 pass / 0 fail / 2 skipped。
- `rionext-master-keep` 容器仍钉着旧镜像 ID，按预期不动。彩排容器已删。

## 重建命令（代理一次性 --build-arg，不改任何脚本）

宿主机代理在 127.0.0.1:7890，容器里用 `host.docker.internal:7890`。
**不要**把代理写进 Dockerfile / package.json / install-*.sh。

```
cd /d/coding/RioNextCTF && docker build \
  --build-arg HTTP_PROXY=http://host.docker.internal:7890 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:7890 \
  --build-arg http_proxy=http://host.docker.internal:7890 \
  --build-arg https_proxy=http://host.docker.internal:7890 \
  --build-arg ALL_PROXY=http://host.docker.internal:7890 \
  -t rionext-kali:rolling -t rionext-kali:master docker/kali
```

预定义代理 ARG 不进缓存 key，已缓存层不受影响。**不要管道**（会吃掉真实退出码）。后台跑、看日志文件。

## 重建前的硬性前提：WSL 内存上限

**两次 `#21 exporting to image` 阶段 OOM（buildkitd 被 EOF 杀掉）的教训**：默认 WSL2 上限是宿主内存的一半（本机 27.8GB → VM 13.5GiB），导出 16GB 镜像时页缓存把 VM 压爆。

根治：`%USERPROFILE%\.wslconfig` 写入下面内容，然后 `docker desktop stop && wsl --shutdown && docker desktop start`：

```
[wsl2]
memory=18GB
```

验证：`docker info --format '{{.MemTotal}}'` 应约 18.8e9。
注意：Docker Desktop 的 `settings-store.json` 里写 `MemoryMiB` **不生效**（本机实测被忽略），只有 `.wslconfig` 管用；改完必须 `wsl --shutdown` 整个停掉 WSL VM 才会重新读配置。

## 方法论：先彩排，再构建（用户明确要求）

所有兼容性验证都在一次性/常驻**彩排容器**里做完，不烧镜像构建次数。正式构建只做一次成功路径。
彩排容器 historically：`docker run -d --name ctf-rehearsal`（带代理 env）+ `docker cp` 脚本进去 + `MSYS_NO_PATHCONV=1 docker exec`。

彩排抓出的 4 个真问题（已全部修掉）：

| 问题 | 现象 | 修复 |
|---|---|---|
| fpylll cp314 轮子元数据漏依赖 | `No module named 'cysignals'` | pip 清单显式加 `cysignals`（1.12.6 有 cp314 轮子） |
| hexdump 不在任何已装包 | 白名单承诺但镜像没有 | apt 加 `bsdextrautils` |
| ncat 不随 nmap | 同上 | apt 加独立包 `ncat` |
| ctf-python 用符号链接 | venv/bin/python → /usr/bin/python3.14 全解析后丢 pyvenv.cfg，静默退回系统 site-packages | 改为 wrapper 脚本：`#!/bin/sh` + `exec /opt/rionext-ctf-venv/bin/python "$@"` |

## 已修复的坑（工作区已改完，不用重复处理）

| 问题 | 现象 | 修复 |
|---|---|---|
| `.dockerignore` 白名单漏新脚本 | `"/verify-ctf-tools.sh": not found` | 两个脚本已加进 `docker/kali/.dockerignore` |
| kali-rolling 包改名/下架 | `E: Unable to locate package bkcrack`（及 p7zip-full、qemu-user-static） | `p7zip-full`→`7zip`；删 `qemu-user-static`（`qemu-user` 提供无 -static 后缀二进制）；删 `bkcrack`（已下架）。白名单/校验/skill 文本/测试已同步 |
| BuildKit 僵尸顶点去重 | 杀 client 后 daemon 侧步骤不死，新构建被去重挂到旧的无代理执行上 | 杀所有 docker build 进程 + `docker desktop restart` 清 in-flight 顶点 |
| Python 3.14 轮子：lief | `No matching distribution found`（无 sdist 无 cp314 轮子） | 已摘除；由 readelf/rabin2/patchelf + pwntools 自带 pyelftools 覆盖 |
| Python 3.14 轮子：ropper | 依赖 filebytes 用 `ast.Str`（3.14 已删） | 已摘除（ROPgadget 覆盖） |
| unicorn 2.1.2 源码编译失败 | pwntools==4.15.0 排除了唯一有轮子的 2.1.4，只能编 2.1.2 sdist；报 `pkg-config not found` → `mprotect`/`PROT_READ` 未声明 | apt 加 `pkg-config libglib2.0-dev`，编译通过 |
| 构建中代理/直连抖动 | apt 并行拉包时代理瞬断；直连拉大包（qemu-user 72MB）也断；PyPI simple 索引被代理返回坏页 | install-ctf.sh 内置韧性：`apt_update`/`apt_install` 直连优先（`env -u` 剥代理）+ 环境回退第二遍（`--fix-missing`），`Queue-Mode=access` 串行 + `Retries=5`；pip 三次重试循环（`--retries 10 --timeout 60`）；gem 三次重试 |
| Clash fake-ip DNS 污染 | 宿主 DNS 被劫持时容器解析到 198.18.0.0/15 假 IP，apt 直连必败 | 上面的双通道设计兜底：直连败了自动走环境里的代理 |
| 导出阶段 OOM（两次） | `#21 exporting to image` 时 buildkitd EOF | 见上面"WSL 内存上限"一节 |

## kali-rolling 2026 快照备忘（py3.14.6 / gcc 15.3 / cmake 4.3.4）

- angr 9.3.4、z3-solver、capstone、pycryptodome、pwntools 4.15.0 在 cp314 上都有现成轮子。
- unicorn 2.1.2 源码编译需要 cmake+gcc+pkg-config+libglib2.0-dev（apt 清单已含）。
- cysignals 1.12.6 有 cp314 轮子，但 fpylll 不会自动拉它。

## 网络备忘

- 本机直连 github.com 的 TLS 长传输必断，走 7890 代理后零重试。
- kali.download（apt）和 PyPI 直连可用但慢且会抖；脚本内的双通道/重试已兜住。
- GitHub API 经共享代理 IP 易 403 限流，拉原始文件用 raw.githubusercontent.com。
- apt 只认**小写** http_proxy/https_proxy 环境变量；只设大写等于没设。

## 验收清单（下次重建后照旧跑一遍）

```
docker images rionext-kali
docker run --rm --entrypoint cat rionext-kali:master /opt/rionext/tool-index.json
docker run --rm --entrypoint sh rionext-kali:master -c "gdb --version | head -1 && r2 -v | head -1 && qemu-x86_64 --version | head -1 && ctf-python -c 'from pwn import *; import angr, z3, scapy, Crypto, sympy, gmpy2, fpylll; print(\"ctf-python ok\")' && tshark -v | head -1 && gp --version | head -1 && ROPgadget --version | head -1 && one_gadget --version | head -1"
```

然后宿主侧 `npx tsc -p tsconfig.json && npm test`（0 fail / 2 skipped 为预期）。
不要 `docker rmi` 任何 `rionext-kali:*`（README 有保护令：`.\rionext.cmd kali protect`）。
