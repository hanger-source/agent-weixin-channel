import { spawn } from 'node:child_process'

export function codexInboundPrompt({ agentName, messageId, text, media }) {
  const mediaSummary = media?.length
    ? `\n附件：${media.map((item) => `${item.kind}${item.localPath ? `=${item.localPath}` : ''}`).join('；')}`
    : ''
  return [
    `$agent-weixin-channel Hang 通过微信向 @${agentName} 发送了一条消息。`,
    `通道消息 ID：${messageId}`,
    `消息正文：${text || '（无文本）'}${mediaSummary}`,
    `请把它作为 Hang 的正常用户输入处理。处理后先用 agent-weixin-channel inbox ack ${messageId} --agent ${agentName} 确认，再使用 send --from ${agentName} 微信回复；send 会在入队前返回其余未确认消息，避免发出过时回复。`,
  ].join('\n')
}

export function dispatchToCodex({ threadId, agentName, messageId, text, media }) {
  if (!threadId) throw new Error(`Codex Agent“${agentName}”缺少 thread ID`)
  const prompt = codexInboundPrompt({ agentName, messageId, text, media })
  return new Promise((resolve, reject) => {
    const images = (media || []).filter((item) => item.kind === 'image' && item.localPath)
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
      if (code === 0) resolve({ queued: true })
      else reject(new Error(`codex queue 退出 ${code}：${output.trim().slice(-1000)}`))
    })
  })
}
