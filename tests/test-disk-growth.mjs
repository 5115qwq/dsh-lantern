// #239：磁盘膨胀守卫
//
// ## 背景
//
// 用户看到一个项目用 sha256 做文件名、升级就换名、旧文件永不清理 ——
// 「升级 10 次就攒 680 MB」。他问本插件有没有同类问题。
//
// 审计结论：
//   · 插件包由包管理器管理，重装时整体替换，不会残留旧版本文件 ✓
//   · 但插件自己的数据目录里有 3 类会增长的东西，必须有上限或可见性：
//       1. tmp/           临时文件 —— 启动时 sweepTmp() 清 1 小时前的
//       2. reports/       HTML 报告 —— pruneReports(keepReports=20)
//       3. usage-archive  账本归档 —— **不自动删**（是用户历史数据），但必须可见
//       4. .corrupt-<ts>  损坏隔离副本 —— 保留最近 5 个，更早的启动时清理
//
// 本测试守的正是"这些上限存在且被真正接上"。
import { readFileSync } from 'node:fs'
import { LANTERN_LIB as LIB } from './paths.mjs'
import { pathToFileURL } from 'node:url'



let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ 磁盘膨胀守卫（#239）════════')
console.log('')

const storage = readFileSync(`${LIB}/storage.js`, 'utf8')
const usage = readFileSync(`${LIB}/usage.js`, 'utf8')
const index = readFileSync(`${LIB}/index.js`, 'utf8')
const rpc = readFileSync(`${LIB}/rpc.js`, 'utf8')
const client = readFileSync(`${LIB}/client.js`, 'utf8')

// ── 1. tmp/ 清理 ──
console.log('【1】tmp/ 临时文件')
t('sweepTmp 存在', /export async function sweepTmp/.test(storage))
t('sweepTmp 有超时参数（默认 1 小时）', /sweepTmp\(maxAgeMs = 3600_000\)/.test(storage))
t('启动时调用 sweepTmp', /await sweepTmp\(\)/.test(index))
t('sweepTmp 会删文件与子目录', /unlink\(full\)/.test(storage) && /rm\(full, \{ recursive: true/.test(storage))

// ── 2. reports/ 上限 ──
console.log('')
console.log('【2】reports/ HTML 报告')
t('pruneReports 存在', /function pruneReports/.test(usage))
t('writeReport 带 keep 参数', /writeReport\(\{[^}]*keep = 20/.test(usage))
t('writeReport 调用 pruneReports', /pruneReports\(keep\)/.test(usage))
t('config 有 keepReports 默认值', /keepReports: 20/.test(index))

// ── 3. usage.jsonl 归档 ──
console.log('')
console.log('【3】usage.jsonl 账本')
t('有滚动函数 rollLedgerIfNeeded', /async function rollLedgerIfNeeded/.test(usage))
t('有大小上限配置 maxLedgerBytes', /maxLedgerBytes/.test(index))
t('归档名带时间戳（不覆盖历史）', /usage-archive-/.test(usage))
t('归档名冲突时退让（不静默覆盖）', /existsSync\(target\)/.test(usage))

// ── 4. .corrupt- 隔离副本清理 ──
console.log('')
console.log('【4】.corrupt- 损坏隔离副本')
t('sweepCorruptions 存在', /export async function sweepCorruptions/.test(storage))
t('默认保留 5 个', /sweepCorruptions\(keep = 5\)/.test(storage))
t('ensureDirs 调用 sweepCorruptions', /await sweepCorruptions\(5\)/.test(storage))
t('按时间戳排序删最旧的', /corrupt\.sort\(\(a, b\) => a\.ts - b\.ts\)/.test(storage))
t('导出清理记录 CORRUPTION_SWEEP_LOG', /export const CORRUPTION_SWEEP_LOG/.test(storage))

// ── 5. 归档可见性 ──
console.log('')
console.log('【5】归档与隔离副本的可见性')
t('archiveStats 存在', /export async function archiveStats/.test(storage))
t('archiveStats 返回 count/bytes', /out\.count = st\.length/.test(storage) && /out\.bytes = /.test(storage))
t('RPC storage/status 透出 archives', /archives: await archiveStats\(\)/.test(rpc))
t('RPC storage/status 透出 corruptions', /corruptions: /.test(rpc))
t('面板显示「账本归档」', /'账本归档'/.test(client))
t('面板显示「损坏隔离」', /'损坏隔离'/.test(client))
t('启动日志汇报归档占用', /账本归档 \$\{arch\.count\}/.test(index))
t('启动日志汇报隔离副本清理', /损坏隔离副本（保留最近 5 个）/.test(index))

// ── 6. logs/ 不再是无用的空目录 ──
console.log('')
console.log('【6】logs/ 空目录')
t('REQUIRED_DIRS 不再包含 logs', !/REQUIRED_DIRS = \[DATA_DIR, PATHS\.tmp, PATHS\.logs, PATHS\.reports\]/.test(storage))
t('确认插件不写 logs/', !/appendFile\(PATHS\.logs|writeFile\(PATHS\.logs/.test(storage + index + rpc))

// ── 7. 运行时确认 ──
console.log('')
console.log('【7】运行时导出')
const mod = await import(pathToFileURL(`${LIB}/storage.js`).href)
t('导出 sweepCorruptions', typeof mod.sweepCorruptions === 'function')
t('导出 archiveStats', typeof mod.archiveStats === 'function')
t('导出 CORRUPTION_SWEEP_LOG', Array.isArray(mod.CORRUPTION_SWEEP_LOG))

// 实际调用一次（当前数据目录没有 corrupt/archive，应返回 0 / 空）
{
  const swept = await mod.sweepCorruptions(5)
  t('sweepCorruptions 可安全调用', typeof swept === 'number', swept)
  const arch = await mod.archiveStats()
  t('archiveStats 返回结构正确', typeof arch.count === 'number' && typeof arch.bytes === 'number', arch)
  console.log(`      当前: 清理 ${swept} 个隔离副本 / 归档 ${arch.count} 个 ${(arch.bytes / 1024).toFixed(1)} KB`)
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0