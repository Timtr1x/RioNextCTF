# 归属说明（NOTICE）

本目录下的 8 个 skill 文件（reverse-native、pwn-chain、apk-reverse、dotnet-reverse、
protocol-pcap、ctf-misc、ctf-crypto、ctf-triage）是 RioNext 的原创文本，为 RioNext 的
Execute 契约（submit_observation / finish_step / checkpoint）、/workspace 目录约定和
镜像内工具白名单专门编写。

其中部分技术清单与决策规则的**思路**参考了下述仓库（按主题适配、用我们自己的
文字重写，未复制原文）：

- reverse-skill — Cybersecurity Skills Router
  https://github.com/zhaoxuya520/reverse-skill
  许可证：MIT，参考时点 commit 7e2097f（v1.0.1）
  借鉴范围：apk-reverse 的 JNI/加固识别、dotnet-reverse 的混淆器识别与字符串解密器
  定位、ctf-misc 的加密 ZIP 决策链 / 固件熵分析 / 隐写信道排序、protocol-pcap 的会话
  地图与帧布局还原、ctf-crypto 的变换链簿记、ctf-triage 的优先级路由与证据纪律，
  以及 ops/ 方法论中的假设驱动、负证据、checkpoint 增量等通用纪律。

MIT License 全文见上述仓库的 LICENSE 文件。
