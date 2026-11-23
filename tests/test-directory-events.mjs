// #242：目录刷新的及时性守卫
//
// ## 背景（用户报告的真实问题）
//
// 「在 Hub 里添加的模型不会立刻刷新出来，只有在设置里添加接口才刷新过来」
//
// ## 根因（DSH 源码核实）
//
// DSH 对两类变更触发**两个不同的事件**：
//
//   llm/adapters-updated  —— provider 增删 / 替换
//                            （适配器装配层变化）
//   llm/models-updated    —— **某个 provider 的模型清单或显示信息变了**
//                            签名：`(provider: string) => void`
//                            触发点：ModelListingCache 的
//                            `changed: () => ctx.emit('llm/models-updated', provider)`
//
// 插件早期只订阅了前者。后果：在 Hub 给**已有** provider 加模型时，
// provider 列表没变 → adapters-updated 不触发 → 目录不重建 → 用户看不到新模型。
//
// 叠加第二个问题：`schedule()` 里有一道「provider 指纹短路」，
// 指纹相同就直接 return。而「加模型」不改变 provider 指纹 ——
// 于是连 60 秒的兜底轮询也被短路挡回，问题被永久隐藏。
//
// 本测试守：
//   ① 两个事件都必须订阅；
//   ② 兜底轮询不得被指纹短路（它必须能强制刷新）；
//   ③ dispose 必须取消两个订阅。
import { readFileSync } from 'node:fs'
import { LANTERN_LIB as LIB } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ 目录刷新及时性守卫（#242）════════')
console.log('')

const src = readFileSync(`${LIB}/directory.js`, 'utf8')

// ── 1. 订阅两个事件 ──
console.log('【1】事件订阅完整性')
t(
  '订阅 llm/adapters-updated（provider 增删）',
  /this\.stopAdaptersUpdated\s*=\s*this\.ctx\.on\(\s*['"]llm\/adapters-updated['"]/.test(src),
)
t(
  '订阅 llm/models-updated（模型清单变化）',
  /this\.stopModelsUpdated\s*=\s*this\.ctx\.on\(\s*['"]llm\/models-updated['"]/.test(src),
  '缺少该订阅会导致 Hub 里新增的模型不刷新',
)

// ── 2. 兜底轮询必须强制刷新 ──
console.log('')
console.log('【2】兜底轮询不被指纹短路')
t(
  '轮询调用 schedule(true)',
  /setInterval\(\s*\(\)\s*=>\s*this\.schedule\(\s*true\s*\)/.test(src),
  '轮询不传 true 就会被指纹短路挡回',
)
t(
  'schedule 接受 fromPoll 参数',
  /schedule\(\s*fromPoll\s*=\s*false\s*\)/.test(src),
)
t(
  '不再因 provider 指纹相同就 return',
  !/if\s*\(\s*ids\s*===\s*this\.lastProviderFingerprint\s*&&\s*this\.entries\.length\s*>\s*0\s*\)\s*\{[^}]*return/.test(src),
  '指纹短路会挡掉「加模型」这类不改变 provider 列表的变更',
)

// ── 3. dispose 取消两个订阅 ──
console.log('')
console.log('【3】清理完整性')
t('dispose 取消 adapters 订阅', /this\.stopAdaptersUpdated\?\.\(\)/.test(src))
t('dispose 取消 models 订阅', /this\.stopModelsUpdated\?\.\(\)/.test(src))
t('dispose 清定时器', /clearInterval\(this\.timer\)/.test(src))
t('dispose 清去抖定时器', /clearTimeout\(this\.debounceTimer\)/.test(src))

// ── 4. 运行时：确认两个事件名是真实存在的 DSH 事件 ──
console.log('')
console.log('【4】事件名对照 DSH（源码）')
{
  // 只做软校验：如果 DSH 源码可读，确认事件名存在
  try {
    const asar = 'D:/DeepSeek-Harness/resources/app.asar'
    const { readFileSync: rf } = await import('node:fs')
    const buf = rf(asar)
    const head = buf.toString('utf8', 0, Math.min(buf.length, 250 * 1024 * 1024))
    const hasAdapters = head.includes("'llm/adapters-updated'")
    const hasModels = head.includes("'llm/models-updated'")
    t('DSH 源码中存在 llm/adapters-updated', hasAdapters)
    t('DSH 源码中存在 llm/models-updated', hasModels)
    if (hasModels) {
      const sig = /['"]llm\/models-updated['"]\s*\(\s*provider\s*:\s*string\s*\)/.test(head)
      console.log(`      ${sig ? '✓' : '·'} 签名 (provider: string) => void${sig ? ' 已确认' : '（未匹配到，但事件存在）'}`)
    }
  } catch {
    console.log('      · DSH 源码不可读，跳过对照')
  }
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0