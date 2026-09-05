---
name: agent-weixin-channel
description: 通过机器共享的 agent-weixin-channel 与 Hang 收发微信文本或媒体，并以两字中文 Agent 名称隔离路由、触发目标和收件箱。用于用户明确要求通过微信联系、通知或回报，或当前任务已有明确的微信通知约定；不要把普通聊天回复自动外发。
license: MIT
---

# Agent Weixin Channel

这是宿主无关的本机通道。整台机器共享一份微信登录态、长轮询、媒体存储、收件人和 durable outbox；每个 Agent 使用独立的两字中文名称、宿主 binding 和 inbox。Agent 不读取凭据，也不直接调用微信协议。

开始时确认工具和通道：

```bash
command -v agent-weixin-channel
agent-weixin-channel --json doctor
agent-weixin-channel --json recipients list
agent-weixin-channel --json agents list
```

`doctor.data.ready=true` 才表示已有登录账号、daemon 正在运行，并至少有一个取得最新 `context_token` 的收件人。若收件人未 ready，请让 Hang 先从微信给机器人发一条消息；不要绕过这个边界直接读取或猜测 token。

首次使用时，为当前 Agent 选择一个机器内唯一、恰好两个汉字的小说人物名，并用一行话描述当前任务。这个名称同时是 Hang 输入的 `@路由名` 和每条出站消息的署名。若当前环境有 `CODEX_THREAD_ID`，同时绑定该 task，使微信入站立即触发 Codex：

```bash
agent-weixin-channel --json agents register 悟空 --description "发布当前版本" --codex-thread "$CODEX_THREAD_ID"
```

没有即时触发 adapter 的宿主省略 `--codex-thread`，使用 mailbox。名称或宿主 binding 已被占用时不可覆盖；换一个两字名称。普通 mailbox 模式不会自行唤醒已经结束 turn 的 Agent。

出站消息固定为三段，不自行重复署名或任务描述：

```text
【悟空】
发布当前版本
构建已经完成
```

发送微信是外部写操作。只有用户明确要求通过微信发送，或当前任务已有明确的微信通知约定时才执行。普通回复、过程状态或没有行动价值的更新不要自动外发。

发送前需要核对内容时使用 dry-run：

```bash
agent-weixin-channel --json send --to hang --from 悟空 --message "构建已经完成" --dry-run
```

实际提交：

```bash
agent-weixin-channel --json send --to hang --from 悟空 --message "构建已经完成"
printf '%s' "测试失败，需要你处理登录授权" | agent-weixin-channel --json send --to hang --from 悟空 --stdin
agent-weixin-channel --json send --to hang --from 悟空 --file /absolute/path/report.pdf --caption "验收报告"
agent-weixin-channel --json send --to hang --from 悟空 --dedupe-key "release-2026-09-05" --message "发布已经完成"
```

`send` 本身是收发同步边界：真正写入 outbox 前，会原子检查当前 Agent 的所有未确认 inbox。若返回 `status=inbox_pending`，本次消息没有入队；先把 `inbox` 数组作为 Hang 的新输入处理，逐条执行 `inbox ack <message-id> --agent 悟空`，再沿用相同 `--dedupe-key` 重试。不要用旧上下文继续发送，也不需要为此安装全局 hook。

`queued` 只表示写入本机 durable outbox；`accepted` 表示微信 API 接受请求，不等同于客户端已读或可见。需要核查时：

```bash
agent-weixin-channel --json messages get <message-id>
agent-weixin-channel --json messages list --limit 20
```

如果已明确等待 Hang 回复，让 Hang 发送 `@悟空 回复内容`。只读取本 Agent 的 inbox，并在处理完成后确认。由 Codex adapter 触发的消息也必须在处理后确认；宿主已接收不等于 Agent 已读：

```bash
agent-weixin-channel --json inbox claim --agent 悟空
agent-weixin-channel --json inbox ack <message-id> --agent 悟空
```

不带 `@两字名称` 或指向未知名称的消息不会自动投递给任何 Agent，避免“最近活跃 Agent”之类的隐式串线。

不要：

- 向未经用户指定的收件人发送。
- 把 token、用户 ID、内部路径或敏感日志写入通知正文。
- 因状态停在 `queued` 而重复提交；先检查 daemon 和原消息，重试时沿用同一个 `--dedupe-key`。
- 把 `accepted` 描述成“已送达”或“已读”。
- 未经用户要求执行 `login`、停止 daemon 或修改收件人别名。
- 读取或确认其他 Agent 的 inbox。
