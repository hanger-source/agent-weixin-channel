import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const tag = args.get('--tag')
if (!tag) {
  console.log(`${manifest.name}@${manifest.version}`)
  process.exit(0)
}

const expected = `v${manifest.version}`
if (tag !== expected) throw new Error(`release tag ${tag} does not match package ${expected}`)

const channel = manifest.version.match(/-(alpha|beta|rc)\./)?.[1] || 'latest'
const prerelease = args.get('--github-prerelease') === 'true'
if ((channel !== 'latest') !== prerelease) {
  throw new Error(`GitHub prerelease=${prerelease} does not match version ${manifest.version}`)
}
const npmTag = channel
const output = args.get('--github-output')
if (output) await appendFile(output, `npm_tag=${npmTag}\n`)

console.log(`${manifest.name}@${manifest.version} -> npm dist-tag ${npmTag}`)
