# @hanger-source/weixin-channel

面向任意 Agent 的本机微信通知通道。它不依赖 DSH、Codex 或其他 Agent 宿主。

## 安装

```bash
npm install -g @hanger-source/weixin-channel
weixin-channel skill install
```

本地开发安装：

```bash
npm install
npm install -g .
weixin-channel skill install
```

## 首次连接

```bash
weixin-channel login
```

扫码成功后工具保存独立凭据并启动唯一 daemon。Hang 需要再从微信给机器人发一条消息，使该会话的 `context_token` 进入收件人注册表。

## 常用命令

```bash
weixin-channel --json doctor
weixin-channel --json recipients list
weixin-channel --json send --to hang --source agent-name --message "任务已经完成"
weixin-channel --json messages get <message-id>
weixin-channel daemon status
```

`send` 也支持 `--message-file`、`--stdin`、`--dedupe-key` 和 `--dry-run`。

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

除交互式 `login` 外，`--json` 模式只在 stdout 写 JSON；daemon 诊断写入 `~/.weixin-channel/daemon.log`。凭据位于私有的 provider 状态目录，不通过 CLI 输出。

消息状态：

- `queued`：已进入本机 durable outbox。
- `sending`：daemon 正在提交。
- `retrying`：瞬态失败，按退避时间重试。
- `accepted`：微信 API 接受请求，不代表对方已读或客户端一定可见。
- `failed`：不可重试或达到五次尝试上限。

## 状态所有权

默认状态目录为 `~/.weixin-channel`，可用 `WEIXIN_CHANNEL_HOME` 覆盖。SQLite 使用 WAL，允许多个 Agent 并发提交；只有 daemon 能读取微信凭据并执行协议调用。

协议适配精确依赖 `dsh-weixin-gateway@0.5.13`，把其私有模块路径封装在 `src/provider.js`，其余代码不依赖该包的内部布局。
