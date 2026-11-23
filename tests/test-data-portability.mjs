// #244：数据可迁移性守卫
//
// ## 背景
//
// 排查「用户该怎么备份」时发现：
//   · README 只说了数据目录在哪，没说**备份什么、怎么迁移**
//   · 面板只有「导出诊断」（排障用，含运行时状态），没有「导出配置」（迁移用）
//
// 对一个「把模型开放给局域网」的网关来说，换机/重装是常见场景 ——
// 用户不该被迫去翻 data/config.json 再手工剔除敏感字段。
//
// 本测试守：
//   ① 存在 config/export RPC，且导出的内容**绝不含密钥/账本**
//   ② 面板有入口
//   ③ README（中英）都写了备份与迁移
import { readFileSync } from 'node:fs'
import { LANTERN_LIB as LIB, LANTERN_DIR } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ 数据可迁移性守卫（#244）════════')
console.log('')

const rpc = readFileSync(`${LIB}/rpc.js`, 'utf8')
const client = readFileSync(`${LIB}/client.js`, 'utf8')

// ── ① config/export 存在且安全 ──
console.log('【1】config/export RPC')
t('RPC 已定义', /case 'config\/export'/.test(rpc))
{
  const i = rpc.indexOf("case 'config/export'")
  const end = rpc.indexOf('case ', i + 10)
  const seg = rpc.slice(i, end > i ? end : i + 1500)

  t('导出内容经过脱敏（redactConfigForExport）', /redactConfigForExport/.test(seg))
  t('不含 keys 字段', !/keys\s*:/.test(seg), '导出体不该带 keys')
  t('不含 usage 字段', !/usage\s*:/.test(seg), '导出体不该带账本')
  t('不含明文密钥字段', !/plaintext|apiKey\s*:/.test(seg))
  t('有 kind 标识（便于识别文件类型）', /kind:\s*'dsh-lantern-config'/.test(seg))
  t('有 version 字段（便于未来兼容）', /version:\s*1/.test(seg))
  t('有 exportedAt 时间戳', /exportedAt/.test(seg))
  t('返回值说明"不含密钥"', /note:/.test(seg))
}

// ── ② 面板入口 ──
console.log('')
console.log('【2】面板入口')
t('面板调用 config/export', /rpc\('config\/export'/.test(client))
t('按钮文案存在', /'导出配置'/.test(client))
t('按钮在诊断区块内', /where: 'diag'/.test(client))

// ── ③ README 覆盖 ──
console.log('')
console.log('【3】README 文档')
{
  const zh = readFileSync(`${LANTERN_DIR}/README.md`, 'utf8')
  t('中文有「备份与迁移」', /### 备份与迁移/.test(zh))
  t('中文提到 keys.json 敏感', /keys\.json.*明文|含明文密钥/.test(zh))
  t('中文提到「导出配置」', /导出配置/.test(zh))
  t('中文有换机步骤', /换机步骤/.test(zh))

  const en = readFileSync(`${LANTERN_DIR}/README.en.md`, 'utf8')
  t('英文有「Backup and migration」', /### Backup and migration/.test(en))
  t('英文提到 Export config', /Export config/.test(en))
  t('英文有迁移步骤', /Moving to another machine/.test(en))
}

// ── ④ 数据目录在包外（迁移的前提）──
console.log('')
console.log('【4】数据目录位置')
{
  const storage = readFileSync(`${LIB}/storage.js`, 'utf8')
  t('DATA_DIR 在包外', /homedir\(\)/.test(storage) && !/export const DATA_DIR = join\(PACKAGE_ROOT/.test(storage))
  t('支持 LANTERN_DATA_DIR 覆盖', /process\.env\.LANTERN_DATA_DIR/.test(storage))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0