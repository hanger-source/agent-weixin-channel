import { spawn } from 'node:child_process'

export function codexInboundPrompt({ agentName, messages }) {
  const entries = messages.map((message, index) => {
    const mediaSummary = message.media?.length
      ? `\n附件：${message.media.map((item) => `${item.kind}${item.localPath ? `=${item.localPath}` : ''}`).join('；')}`
      : ''
    return `${index + 1}. 通道消息 ID：${message.id}\n消息正文：${message.text || '（无文本）'}${mediaSummary}`
  })
  const ids = messages.map((message) => message.id)
  return [
    `$agent-weixin-channel Hang 通过微信向 @${agentName} 连续发送了 ${messages.length} 条消息。`,
    ...entries,
    `请按顺序把它们作为 Hang 的同一批正常用户输入处理。处理后使用 agent-weixin-channel inbox ack ${ids.join(' ')} --agent ${agentName} 一次确认整批，再使用 send --from ${agentName} 微信回复；send 会在入队前返回其余未确认消息。`,
  ].join('\n')
}

export function dispatchToCodex({ threadId, agentName, messages }) {
  if (!threadId) throw new Error(`Codex Agent“${agentName}”缺少 thread ID`)
  const prompt = codexInboundPrompt({ agentName, messages })
  return new Promise((resolve, reject) => {
    const images = messages.flatMap((message) => message.media || [])
      .filter((item) => item.kind === 'image' && item.localPath)
    const args = ['queue', '--thread', threadId, '--message', prompt]
    for (const item of images) args.push('--image', item.localPath)
    const child = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`codex queue 超过 15 秒：${output.trim().slice(-1000)}`))
    }, 15_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ queued: true, count: messages.length })
      else reject(new Error(`codex queue 退出 ${code}：${output.trim().slice(-1000)}`))
    })
  })
}
