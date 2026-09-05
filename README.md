# @hanger-source/agent-weixin-channel

面向任意 Agent 的本机微信通知通道。它不依赖 DSH、Codex 或其他 Agent 宿主。

## 安装

```bash
npm install -g @hanger-source/agent-weixin-channel
gh skill install hanger-source/agent-weixin-channel agent-weixin-channel --agent universal --scope user
```

本地开发安装：

```bash
npm install
npm install -g .
gh skill install . agent-weixin-channel --from-local --agent universal --scope user
```

## 首次连接

```bash
agent-weixin-channel login
```

扫码成功后工具保存独立凭据并启动唯一 daemon。Hang 需要再从微信给机器人发一条消息，使该会话的 `context_token` 进入收件人注册表。

## 常用命令

```bash
agent-weixin-channel --json doctor
agent-weixin-channel --json recipients list
agent-weixin-channel --json agents register 悟空 --description "发布当前版本"
agent-weixin-channel --json send --to hang --from 悟空 --message "任务已经完成"
agent-weixin-channel --json send --to hang --from 悟空 --file /absolute/path/report.pdf --caption "验收报告"
agent-weixin-channel --json messages get <message-id>
agent-weixin-channel --json inbox claim --agent 悟空
agent-weixin-channel --json inbox ack <message-id-1> <message-id-2> --agent 悟空
agent-weixin-channel daemon status
```

`send` 支持文本、图片、视频和普通文件，也支持 `--message-file`、`--stdin`、`--dedupe-key` 和 `--dry-run`。实际写入 outbox 前，它会在同一个 SQLite 事务中检查当前 Agent 的未确认 inbox；若有新消息，则返回 `inbox_pending` 和消息内容，本次出站不会入队。Agent 处理并 `inbox ack` 后再重试发送，因此不会带着旧上下文回复。入站图片、视频、文件和语音会通过 SDK 的 CDN 下载、AES 解密和媒体存储链落到本机；语音会尽可能转为 WAV。Codex binding 会把图片作为 image input，把其他媒体的绝对路径写入触发消息。

## Agent 路由

一台机器只运行一个通道 daemon。每个 Agent 自己选择一个机器内唯一、恰好两个汉字的小说人物名，并声明当前任务描述。这个名称同时用于微信路由与出站署名；内部 UUID 只负责数据库关联，不暴露给 Hang，也不作为 CLI 参数。

出站文本固定渲染为：

```text
【悟空】
发布当前版本
任务已经完成
```

Codex task 可以在注册时绑定自己的 thread。微信消息到达后，daemon 会等待 1.5 秒连续输入窗口；同一 Agent 在窗口内收到的消息会按原顺序合并为一个批次，再调用本机 Codex App Server 的队列入口送入该 task：

```bash
agent-weixin-channel --json agents register 悟空 \
  --description "发布当前版本" \
  --codex-thread "$CODEX_THREAD_ID"
```

没有宿主 adapter 的 Agent 使用默认 mailbox，并通过 `inbox claim/ack` 消费。共享的是微信连接和数据库；隔离的是 Agent 名称、宿主目标和 inbox。

Hang 回复时使用：

```text
@悟空 可以发布
```

该消息只进入“悟空”的 inbox。不带路由或指向未知名称的消息会保留在通道记录中，但不会猜测投递对象。`inbox claim` 以原子方式领取一条消息；`inbox ack` 接受一个或多个消息 ID，以一次全成或全不成的事务确认整批。宿主投递与 Agent 阅读是两个状态：消息即使已经排给 Codex，在 Agent 确认前仍属于未读；`send` 会把所有未确认消息一起作为出站同步屏障返回。

`doctor.data.ready=true` 要求 daemon 已 ready、最近一次长轮询健康，并且至少有一个收件人取得了 `context_token`；进程存活本身不等于微信通道可用。

## JSON 契约

成功：

```json
{"ok":true,"data":{"id":"...","status":"queued","deduplicated":false}}
```

失败：

```json
{"ok":false,"error":{"code":"WEIXIN_CHANNEL_ERROR","message":"..."}}
```

除交互式 `login` 外，`--json` 模式只在 stdout 写 JSON；daemon 诊断写入 `~/.agent-weixin-channel/daemon.log`。凭据位于私有的 provider 状态目录，不通过 CLI 输出。

消息状态：

- `queued`：已进入本机 durable outbox。
- `sending`：daemon 正在提交。
- `retrying`：瞬态失败，按退避时间重试。
- `accepted`：微信 API 接受请求，不代表对方已读或客户端一定可见。
- `failed`：不可重试或达到五次尝试上限。

当 `send` 返回 `inbox_pending` 时，消息尚未进入 outbox；先处理并确认返回的 inbox，再使用相同 `--dedupe-key` 重试。

## 状态所有权

默认状态目录为 `~/.agent-weixin-channel`，可用 `AGENT_WEIXIN_CHANNEL_HOME` 覆盖。SQLite 使用 WAL，允许多个 Agent 并发提交，并以 Agent 名称隔离 inbox；只有 daemon 能读取微信凭据并执行协议调用。这是同一 macOS 用户内的逻辑隔离，不是对本机恶意进程的安全沙箱。

协议适配精确依赖 `dsh-weixin-gateway@0.5.13`，把其私有模块路径封装在 `src/provider.js`，其余代码不依赖该包的内部布局。

npm 产物只包含构建后的 `dist`、README 和 LICENSE。GitHub Release 触发 npm trusted publishing；Skill 独立位于 `skills/agent-weixin-channel`，由 `gh skill install` 安装和跟踪版本，不由 npm 包复制。

使用 `npm run release:prepare -- 0.2.0-alpha.1`、`0.2.0-beta.1`、`0.2.0-rc.1` 或 `0.2.0` 构建对应发布。`gh skill publish --tag v0.2.0-rc.1` 创建 GitHub Release 后，release workflow 会校验 tag、版本和 prerelease 标记，再分别发布到 npm `alpha`、`beta`、`rc` 或 `latest` dist-tag。
