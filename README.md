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
agent-weixin-channel --json agents register release-agent --name "发布 Agent"
agent-weixin-channel --json send --to hang --from release-agent --message "任务已经完成"
agent-weixin-channel --json send --to hang --from release-agent --file /absolute/path/report.pdf --caption "验收报告"
agent-weixin-channel --json messages get <message-id>
agent-weixin-channel --json inbox claim --agent release-agent
agent-weixin-channel daemon status
```

`send` 支持文本、图片、视频和普通文件，也支持 `--message-file`、`--stdin`、`--dedupe-key` 和 `--dry-run`。入站图片、视频、文件和语音会通过 SDK 的 CDN 下载、AES 解密和媒体存储链落到本机；语音会尽可能转为 WAV。Codex binding 会把图片作为 image input，把其他媒体的绝对路径写入触发消息。

## Agent 路由

一台机器只运行一个通道 daemon。每个 Agent 自己选择一个稳定 ID，并注册一个显示名。出站文本会渲染成 `【显示名】正文`，但数据库里仍分别保存 Agent ID、显示名和正文。

Codex task 可以在注册时绑定自己的 thread。微信消息到达后，daemon 会调用本机 Codex App Server 的队列入口，立即把消息作为下一条用户输入送入该 task：

```bash
agent-weixin-channel --json agents register release-agent \
  --name "发布 Agent" \
  --codex-thread "$CODEX_THREAD_ID"
```

没有宿主 adapter 的 Agent 使用默认 mailbox，并通过 `inbox claim/ack` 消费。共享的是微信连接和数据库；隔离的是 Agent ID、宿主目标和 inbox。

Hang 回复时使用：

```text
@release-agent 可以发布
```

该消息只进入 `release-agent` 的 inbox。不带路由或指向未知 ID 的消息会保留在通道记录中，但不会猜测投递对象。`inbox claim` 以原子方式领取一条消息，处理完后用 `inbox ack` 确认。

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

## 状态所有权

默认状态目录为 `~/.agent-weixin-channel`，可用 `AGENT_WEIXIN_CHANNEL_HOME` 覆盖。SQLite 使用 WAL，允许多个 Agent 并发提交，并以 Agent ID 隔离 inbox；只有 daemon 能读取微信凭据并执行协议调用。这是同一 macOS 用户内的逻辑隔离，不是对本机恶意进程的安全沙箱。

协议适配精确依赖 `dsh-weixin-gateway@0.5.13`，把其私有模块路径封装在 `src/provider.js`，其余代码不依赖该包的内部布局。

npm 产物只包含构建后的 `dist`、README 和 LICENSE。GitHub Release 触发 npm trusted publishing；Skill 独立位于 `skills/agent-weixin-channel`，由 `gh skill install` 安装和跟踪版本，不由 npm 包复制。

使用 `npm run release:prepare -- 0.2.0-alpha.1`、`0.2.0-beta.1`、`0.2.0-rc.1` 或 `0.2.0` 构建对应发布。`gh skill publish --tag v0.2.0-rc.1` 创建 GitHub Release 后，release workflow 会校验 tag、版本和 prerelease 标记，再分别发布到 npm `alpha`、`beta`、`rc` 或 `latest` dist-tag。
