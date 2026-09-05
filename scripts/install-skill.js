import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function installSkill() {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill')
  const target = path.join(os.homedir(), '.agents', 'skills', 'weixin-channel')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: true })
  return target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${installSkill()}\n`)
}
