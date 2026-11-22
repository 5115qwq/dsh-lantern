/**
 * 能力覆盖来源优先级（BUG #28 的回归护栏）。
 *
 * 规则：探针写回（origin:'probe'）不能覆盖用户手动设置（origin:'user'），
 * 但用户可以推翻探针，探针可以互相覆盖（反复测试会更新结论）。
 *
 * 为什么这条重要：探针判 supported 的依据只是「请求没报错」，
 * 上游完全可能悄悄忽略 temperature 参数；而用户手填 unsupported 是实测结论。
 * 用弱证据推翻强证据会让「我明明设过它不支持」变成不可解释的行为。
 */
import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs'
import { PATHS, ensureDirs } from '../lib/storage.js'

const ROOT = `${LANTERN_DIR}/lib/capabilities.js`
const src = fs.readFileSync(ROOT, 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('【源码级】')
check('setOverride 接受 origin 参数（默认 user）', /async setOverride\(provider, model, field, value, origin = 'user'\)/.test(src))
check('probe 不能覆盖非 probe 记录', /if \(origin === 'probe' && existing !== undefined && existing\.origin !== 'probe'\)/.test(src))
check('写回时记录 origin', /this\.overrides\.set\(key, \{ value, at: Date\.now\(\), origin \}\)/.test(src))
check('test() 回写传 origin=probe', /setOverride\(provider, model, item, probe\.value, 'probe'\)/.test(src))

console.log('\n【行为级：真实 CapabilityResolver】')
const mod = await import('../lib/capabilities.js')
const { CapabilityResolver, VALUE } = mod

// persist 会写插件自己的 data/capabilities.json —— 先把原文件备份，测完还原
// 数据目录位置由 storage.js 决定（可能在插件包之外），所以必须从这里取，
// 不能硬编码 `${LANTERN_DIR}/data` —— 否则备份/还原的是错误的文件。
await ensureDirs()
const LIVE = PATHS.capabilities
const backup = fs.existsSync(LIVE) ? fs.readFileSync(LIVE) : undefined
console.log('  （已备份 capabilities.json @ ' + LIVE + '，' + (backup ? backup.length + ' B' : '原本不存在') + '）')

try {
  const reg = new CapabilityResolver({ llm: {} }, () => ({ capabilities: { profiles: 'use-builtin', learnNegative: true } }))
  check('可实例化', typeof reg.setOverride === 'function')

  // 1) 用户手勾 unsupported
  await reg.setOverride('p', 'm', 'temperature', VALUE.unsupported)
  check('用户手勾后读到 unsupported', reg.resolveField('p', 'm', 'temperature').value === 'unsupported')
  check('来源标记为 declared', reg.resolveField('p', 'm', 'temperature').source === 'declared')

  // 2) 探针写 supported → 必须被拒
  const applied = await reg.setOverride('p', 'm', 'temperature', VALUE.supported, 'probe')
  check('探针写 supported 被拒绝（返回 false）', applied === false, 'applied=' + applied)
  check('用户的 unsupported 仍在', reg.resolveField('p', 'm', 'temperature').value === 'unsupported')

  // 3) 用户自己改 → 应成功
  const byUser = await reg.setOverride('p', 'm', 'temperature', VALUE.supported)
  check('用户可以覆盖自己（返回 true）', byUser === true)
  check('值已变 supported', reg.resolveField('p', 'm', 'temperature').value === 'supported')

  // 4) 探针之间可以互相覆盖
  await reg.setOverride('p', 'm2', 'tools', VALUE.unknown, 'probe')
  const again = await reg.setOverride('p', 'm2', 'tools', VALUE.supported, 'probe')
  check('探针覆盖探针允许（返回 true）', again === true, 'again=' + again)
  check('探针值已更新', reg.resolveField('p', 'm2', 'tools').value === 'supported')

  // 5) 清除覆盖仍可用
  await reg.setOverride('p', 'm', 'temperature', null)
  check('清除覆盖后回落到下一层（非 declared）', reg.resolveField('p', 'm', 'temperature').source !== 'declared')

  // 6) origin 会被持久化（重启后仍然知道这条是探针写的）
  const doc = JSON.parse(fs.readFileSync(LIVE, 'utf8'))
  const probeKey = Object.keys(doc.overrides ?? {}).find((k) => k.includes('p\u0000m2\u0000tools'))
  check('origin 落盘（重载后仍可分辨）', probeKey !== undefined && doc.overrides[probeKey].origin === 'probe', JSON.stringify(doc.overrides[probeKey ?? '']))
} finally {
  if (backup !== undefined) fs.writeFileSync(LIVE, backup)
  else if (fs.existsSync(LIVE)) fs.rmSync(LIVE)
  console.log('  （已还原 capabilities.json）')
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
