import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function stateHome() {
  return process.env.AGENT_WEIXIN_CHANNEL_HOME?.trim() || path.join(os.homedir(), '.agent-weixin-channel')
}

export function statePaths() {
  const home = stateHome()
  return {
    home,
    database: path.join(home, 'channel.sqlite'),
    log: path.join(home, 'daemon.log'),
    pid: path.join(home, 'daemon.pid'),
    ready: path.join(home, 'daemon.ready.json'),
    provider: path.join(home, 'provider'),
  }
}

export function ensureStateHome() {
  const paths = statePaths()
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(paths.provider, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(paths.home, 0o700) } catch {}
  try { fs.chmodSync(paths.provider, 0o700) } catch {}
  return paths
}

export function configureProviderState() {
  const paths = ensureStateHome()
  process.env.OPENCLAW_STATE_DIR = paths.provider
  return paths
}
