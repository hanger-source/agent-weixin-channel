---
name: weixin-channel
description: 通过本机 weixin-channel 通道向 Hang 发送微信通知，并检查通知队列、收件人和通道状态。用于用户明确要求通过微信联系、通知或回报，或当前任务已有明确的微信通知约定；不要把普通聊天回复自动外发。
---

# Weixin Channel

这是宿主无关的本机通知工具。微信登录态、长轮询、收件人和 durable outbox 由常驻 daemon 管理；Agent 不读取凭据，也不直接调用微信协议。

开始时确认工具和通道：

```bash
command -v weixin-channel
weixin-channel --json doctor
weixin-channel --json recipients list
```

`doctor.data.ready=true` 才表示已有登录账号、daemon 正在运行，并至少有一个取得最新 `context_token` 的收件人。若收件人未 ready，请让 Hang 先从微信给机器人发一条消息；不要绕过这个边界直接读取或猜测 token。

发送微信是外部写操作。只有用户明确要求通过微信发送，或当前任务已有明确的微信通知约定时才执行。普通回复、过程状态或没有行动价值的更新不要自动外发。

发送前需要核对内容时使用 dry-run：

```bash
weixin-channel --json send --to hang --source codex --message "构建已经完成" --dry-run
```

实际提交：

```bash
weixin-channel --json send --to hang --source codex --message "构建已经完成"
printf '%s' "测试失败，需要你处理登录授权" | weixin-channel --json send --to hang --source release-agent --stdin
weixin-channel --json send --to hang --source nightly-job --dedupe-key "nightly-2026-09-05" --message "夜间任务已经完成"
```

`queued` 只表示写入本机 durable outbox；`accepted` 表示微信 API 接受请求，不等同于客户端已读或可见。需要核查时：

```bash
weixin-channel --json messages get <message-id>
weixin-channel --json messages list --limit 20
```

不要：

- 向未经用户指定的收件人发送。
- 把 token、用户 ID、内部路径或敏感日志写入通知正文。
- 因状态停在 `queued` 而重复提交；先检查 daemon 和原消息，重试时沿用同一个 `--dedupe-key`。
- 把 `accepted` 描述成“已送达”或“已读”。
- 未经用户要求执行 `login`、停止 daemon 或修改收件人别名。
