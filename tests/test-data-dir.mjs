// #237：数据目录位置守卫
//
// ## 事故背景（必须记住）
//
// 早期 `storage.js` 把数据目录写成 `join(PACKAGE_ROOT, 'data')` —— 即**数据放在插件包里面**。
//
// 插件以包的形式安装时（profile 的 dependencies 里记 `github:owner/repo`），
// 包管理器会在重装时**整体替换包目录**。一次 DSH 重启触发了重装，结果：
//   · 3 个 API Key 丢失（keys.json）
//   · 全部用量账本丢失（usage.jsonl）
//   · 能力学习缓存丢失（capabilities.json）
//   · config.json 被重置为默认值（enabled: false → 网关静默停止服务）
//   · 自定义模型配置全部清空
//
// ## 本测试守什么
//
// 1. `DATA_DIR` 必须在 `PACKAGE_ROOT` **之外**；
// 2. 必须支持 `LANTERN_DATA_DIR` 环境变量覆盖；
// 3. 必须能识别旧位置并迁移（`migrateLegacyData` 存在且不覆盖已有文件）。
//
// 这些断言是静态的（读源码 + 动态 import 取值），不需要真实运行环境。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { sep } from 'node:path'

import { LANTERN_LIB as LIB } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 200))) }
}

console.log('════════ 数据目录位置守卫（#237）════════')
console.log('')

const src = readFileSync(`${LIB}/storage.js`, 'utf8')

// ── 1. 静态检查：源码不得把 DATA_DIR 直接拼在 PACKAGE_ROOT 下 ──
console.log('【1】源码层面')
t('DATA_DIR 不再等于 join(PACKAGE_ROOT, \'data\')',
  !/export const DATA_DIR = join\(PACKAGE_ROOT, ['"]data['"]\)/.test(src))
t('包含 PACKAGE_ROOT 之外的解析逻辑',
  /homedir\(\)/.test(src) || /LANTERN_DATA_DIR/.test(src))
t('支持 LANTERN_DATA_DIR 覆盖',
  /process\.env\.LANTERN_DATA_DIR/.test(src))
t('导出 LEGACY_DATA_DIR（用于迁移）',
  /export const LEGACY_DATA_DIR/.test(src))
t('导出 migrateLegacyData()',
  /export async function migrateLegacyData/.test(src))
t('迁移不覆盖已有文件（有 access 检查）',
  /await access\(to\)/.test(src))

// ── 2. 动态检查：实际取值不在包目录内 ──
console.log('')
console.log('【2】运行时取值')
const mod = await import(pathToFileURL(`${LIB}/storage.js`).href)
const root = mod.PACKAGE_ROOT
const dir = mod.DATA_DIR
const legacy = mod.LEGACY_DATA_DIR

console.log(`    PACKAGE_ROOT:    ${root}`)
console.log(`    DATA_DIR:        ${dir}`)
console.log(`    LEGACY_DATA_DIR: ${legacy}`)

t('DATA_DIR 是绝对路径', /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('/'))
t('DATA_DIR 不在 PACKAGE_ROOT 内',
  !dir.startsWith(root + sep) && dir !== root,
  { dataDir: dir, pkgRoot: root })
t('DATA_DIR 位于 homedir 下（可预期的固定位置）',
  dir.startsWith(homedir()),
  { dataDir: dir, home: homedir() })
t('DATA_DIR 路径含 lantern-data',
  /lantern-data/.test(dir), dir)
t('LEGACY_DATA_DIR 指向包内 data/',
  legacy.startsWith(root) && /[\\/]data$/.test(legacy), legacy)

// ── 3. PATHS 全部落在 DATA_DIR 下 ──
console.log('')
console.log('【3】PATHS 一致性')
for (const key of ['config', 'keys', 'capabilities', 'usage', 'attachmentLedger']) {
  const p = mod.PATHS[key]
  t(`PATHS.${key} 在 DATA_DIR 内`, p.startsWith(dir + sep), p)
}

// ── 4. 环境变量覆盖 ──
console.log('')
console.log('【4】环境变量覆盖（子进程验证）')
{
  const { execFileSync } = await import('node:child_process')
  const code = `
    const m = await import(${JSON.stringify(pathToFileURL(`${LIB}/storage.js`).href)});
    console.log(m.DATA_DIR)
  `
  try {
    const out = execFileSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANTERN_DATA_DIR: 'X:/custom-data' },
    }).trim()
    t('LANTERN_DATA_DIR 生效', out === 'X:/custom-data' || out === 'X:\\custom-data', out)
  } catch (e) {
    t('LANTERN_DATA_DIR 生效', false, String(e.message).slice(0, 120))
  }
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0