/**
 * wire_profile.mjs —— 绕开 pnpm，把 dsh-jev-prune 手工接进一个 DSH profile。
 *
 * 为什么需要它：`dsh plugin add` 会转发给 pnpm，而 pnpm 在本机装了三次都没成功
 * （第一次被并发 install 冲掉、第二次被 npm 当多余包清掉、第三次 24 分钟无输出被终止）。
 * 而 DSH 的插件加载契约其实是两件很朴素的事：
 *   ① 包能在 profile 的解析范围内被 import 到
 *   ② profile 的 cordis.patch.yml 里有一条把它 insert 进配置树
 * 这两件事手工做完全等价，只是绕开了 pnpm 那层。
 *
 * 代价：偏离官方支持路径（`dsh plugin add`），所以升级 DSH 后要重新跑一次。
 *
 * 用法：
 *   node wire_profile.mjs <DSH_HOME> <profile名> [--plugin <插件目录>]
 *   --plugin 省略时默认为**本脚本所在目录**（即插件仓库根）。
 * 例：
 *   node wire_profile.mjs ../../_dshhome jevtest
 *   node wire_profile.mjs ~/.dsh web --plugin /path/to/dsh-jev-prune
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

// 手工解析参数（保持零依赖）：位置参数 <DSH_HOME> [profile名]，可选 --plugin <dir>
let dshHome
let profileName
let pluginDir
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--plugin' || arg === '-p') {
    pluginDir = args[i + 1]
    if (pluginDir == null) {
      console.error('❌ --plugin 需要一个目录参数')
      process.exit(2)
    }
    i += 1
  } else if (dshHome == null) {
    dshHome = arg
  } else if (profileName == null) {
    profileName = arg
  } else {
    console.error(`❌ 多余的参数：${arg}`)
    process.exit(2)
  }
}

const pluginSrc = resolve(pluginDir ?? here)
const packageName = JSON.parse(readFileSync(join(pluginSrc, 'package.json'), 'utf8')).name

// issue #12：profile 名此前在用法行写"可选"，实际 join() 会拿到 undefined 抛原始 TypeError——
// 要么给默认要么明确必填，这里选择明确必填 + 友好报错
if (!dshHome || !profileName) {
  console.error('用法: node wire_profile.mjs <DSH_HOME> <profile名> [--plugin <插件目录>]')
  if (!dshHome) console.error('  缺少 <DSH_HOME>（DSH 的主目录，含 profiles/ 的那个）')
  if (!profileName) console.error('  缺少 <profile名>（dsh --profile <名字> 用的那个名字，必填）')
  process.exit(2)
}

// issue #12：Node 的 path.resolve 不展开 ~，示例却写着 ~/.dsh —— 先展开
if (dshHome === '~' || dshHome.startsWith('~/') || dshHome.startsWith('~\\')) {
  dshHome = join(homedir(), dshHome.slice(1).replace(/^[\\/]/, ''))
}

const profileDir = join(resolve(dshHome), 'profiles', profileName)
if (!existsSync(profileDir)) {
  console.error(`❌ profile 目录不存在：${profileDir}`)
  console.error('   先用 dsh --profile <name> --from-default-profile headless --dump-config 创建它')
  process.exit(1)
}

// ---------------------------------------------------------------- 1. 落包
// 用复制而不是软链：Node 默认把软链解析成真实路径，那样插件里的
// `import '@deepseek-ai/...'` 会从插件源目录往上找、找不到 DSH 的 node_modules。
//
// 放两个位置（DSH 的 profile 解析规则没有公开文档，而它源码里有个
// `healProfilesModuleFallback`，说明确实存在回退链）：
//   ① profile 自己的 node_modules —— pnpm 正常安装时的位置
//   ② $DSH_HOME/node_modules      —— 回退链上的位置
// 复制清单**从 package.json 的 files 字段推导**，而不是硬写：
// 硬写清单会漂移——实测加过 prune.js 之后忘了同步，装进 profile 后启动直接
// ERR_MODULE_NOT_FOUND。files 字段本来就该是唯一的真相来源。
const pkg = JSON.parse(readFileSync(join(pluginSrc, 'package.json'), 'utf8'))
const declared = Array.isArray(pkg.files) ? pkg.files : []
const files = [...new Set([...declared, 'package.json', 'cordis.patch.yml', 'README.md'])]
const missing = files.filter((f) => !existsSync(join(pluginSrc, f)))
if (missing.length > 0) {
  console.error(`❌ package.json 的 files 里声明了但文件不存在：${missing.join(', ')}`)
  process.exit(1)
}
// 顺带守住另一类漂移：代码里的相对 import 必须都能落到实际文件上
// （issue #13：此前只扫 .js，4 个 .mjs 的相对 import 全部漏检）
const srcFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
const brokenImports = []
for (const f of srcFiles) {
  const text = readFileSync(join(pluginSrc, f), 'utf8')
  for (const m of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
    if (!existsSync(join(pluginSrc, m[1]))) brokenImports.push(`${f} → ./${m[1]}`)
  }
}
if (brokenImports.length > 0) {
  console.error(`❌ 相对 import 指向不存在的文件（复制后会在宿主里启动失败）：\n  ${brokenImports.join('\n  ')}`)
  process.exit(1)
}

const targets = [
  join(profileDir, 'node_modules', packageName),
  join(resolve(dshHome), 'node_modules', packageName),
]
for (const pluginDest of targets) {
  mkdirSync(pluginDest, { recursive: true })
  for (const file of files) {
    copyFileSync(join(pluginSrc, file), join(pluginDest, file))
  }
  console.log(`  已落包 ${pluginDest}（${files.length} 个文件）`)
}
console.log(`✅ 插件已复制到 ${targets.length} 个候选解析位置`)

// ---------------------------------------------------------------- 2. 改 patch
const patchPath = join(profileDir, 'cordis.patch.yml')
const original = readFileSync(patchPath, 'utf8')
const entry = `- insert:\n    - id: jev-prune\n      name: ${packageName}\n`
// 模板文件开头是注释，判断"是不是空数组"必须先剥掉注释和空行，
// 否则会把条目追加在 `[]` 后面 → 顶层两个节点 → YAML 解析失败。
const comments = original.split('\n').filter((l) => l.trim().startsWith('#')).join('\n')
const effective = original
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')
  .trim()

let next
if (effective.includes(packageName) && !effective.split('\n').some((l) => l.trim() === '[]')) {
  next = original
  console.log('✅ cordis.patch.yml 里已有该条目，跳过')
} else {
  // 重建：保留注释头，丢掉空数组占位行（`[]` 与条目并存会让顶层出现两个节点 → YAML 解析失败），
  // 然后把我们的 insert 条目放进去。已经存在的同 id 条目先删掉再重加，保证幂等。
  const kept = original
    .split('\n')
    .filter((l) => l.trim().startsWith('#'))
    .join('\n')
    .trimEnd()
  const rest = original
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && l.trim() !== '[]' && l.trim() !== '')
    .join('\n')
    .trim()
  const withoutOurs = rest
    .split(/\n(?=- insert:)/) // 按顶层条目切
    .filter((block) => !block.includes(packageName))
    .join('\n')
    .trim()
  next = `${kept}\n${withoutOurs ? `${withoutOurs}\n` : ''}${entry}`
  console.log(rest === '' ? '✅ 已写入 cordis.patch.yml（原先是空数组）' : '✅ 已重建 cordis.patch.yml')
}
writeFileSync(patchPath, next, 'utf8')
console.log(`\n--- ${patchPath} ---\n${next}`)

// ---------------------------------------------------------------- 3. 下一步提示
console.log('下一步：')
console.log(`  1. 确认进了配置树：`)
console.log(`     DSH_HOME=${resolve(dshHome)} dsh --profile ${profileName} --dump-config | grep -A1 jev-prune`)
console.log(`  2. 真实跑一次会话，用 jev_probe_shapes 工具校正事件字段名`)
