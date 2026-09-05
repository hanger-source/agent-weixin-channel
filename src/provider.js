import { createRequire } from 'node:module'

import { configureProviderState } from './paths.js'

const require = createRequire(import.meta.url)

export function providerPackage() {
  const manifest = require('dsh-weixin-gateway/package.json')
  return { name: manifest.name, version: manifest.version }
}

export async function loadProvider() {
  configureProviderState()
  const [accounts, login, api, send] = await Promise.all([
    import('dsh-weixin-gateway/lib/weixin/accounts.js'),
    import('dsh-weixin-gateway/lib/weixin/login-qr.js'),
    import('dsh-weixin-gateway/lib/weixin/api/api.js'),
    import('dsh-weixin-gateway/lib/weixin/send.js'),
  ])
  return { accounts, login, api, send }
}

export async function performLogin() {
  const provider = await loadProvider()
  const start = await provider.login.startWeixinLoginWithQr({
    apiBaseUrl: provider.accounts.DEFAULT_BASE_URL,
    verbose: true,
  })
  if (!start.qrcodeUrl) throw new Error(start.message || '微信二维码生成失败')
  await provider.login.displayQRCode(start.qrcodeUrl)
  process.stdout.write(`${start.message}\n`)
  const result = await provider.login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: provider.accounts.DEFAULT_BASE_URL,
    timeoutMs: 480_000,
    verbose: true,
  })
  if (!result.connected) {
    if (result.alreadyConnected) {
      const accountId = provider.accounts.listIndexedWeixinAccountIds().at(-1)
      const stored = accountId ? provider.accounts.loadWeixinAccount(accountId) : null
      if (accountId && stored?.token) {
        return {
          accountId,
          userId: stored.userId || null,
          baseUrl: stored.baseUrl || provider.accounts.DEFAULT_BASE_URL,
        }
      }
      throw new Error('该微信已绑定，但本工具没有对应的本地凭据；需要重新建立绑定')
    }
    throw new Error(result.message || '微信登录未完成')
  }
  if (!result.accountId || !result.botToken) throw new Error('微信登录结果缺少 accountId 或 botToken')
  provider.accounts.saveWeixinAccount(result.accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl || provider.accounts.DEFAULT_BASE_URL,
    userId: result.userId,
  })
  provider.accounts.registerWeixinAccountId(result.accountId)
  return {
    accountId: result.accountId,
    userId: result.userId || null,
    baseUrl: result.baseUrl || provider.accounts.DEFAULT_BASE_URL,
  }
}

export function extractText(message) {
  const texts = []
  for (const item of message.item_list || []) {
    if (item?.type === 1 && item.text_item?.text != null) texts.push(String(item.text_item.text))
  }
  return texts.join('\n')
}
