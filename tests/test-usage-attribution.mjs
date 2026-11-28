#!/usr/bin/env node
/**
 * 守卫：重启后真实运行验证 + 静态审查这一轮修掉的 6 类问题。
 *
 * 1. 折叠提示统计三张表（含交叉表），不再「说藏 3 个、展开多 29 行」
 * 2. 探测记录只在「没有 Key」时归一为 internal，保留带真实 Key 的历史用量
 * 3. 导出脱敏：敏感键名精确化 + 高熵兜底避开 ID 型字段，不误伤正常诊断信息
 * 4. breaker 匿名哨兵统一 'anonymous'
 * 5. 三个聚合器对「只有空 tool_use 块」判空（hasUsableTool）
 * 6. 两处同名「冷却秒数」标签区分
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')
const rd = (f) => readFileSync(join(LIB, f), 'utf8')
const c = rd('client.js')
const u = rd('usage.js')
const r = rd('rpc.js')
const b = rd('breaker.js')
const p = rd('protocol.js')
const rs = rd('responses.js')
const a = rd('anthropic.js')
const i = rd('index.js')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

console.log('════════ A. 折叠提示统计三张表 ════════')
ok('有 hiddenCross', c.includes('const hiddenCross = (usage.cross ?? [])'))
ok('hiddenTotal 合并三张表', c.includes('const hiddenTotal = hiddenKeys + hiddenModels + hiddenCross'))
ok('提示用 hiddenTotal', c.includes('${hiddenTotal} 条历史记录'))
ok('hiddenTotal===0 时不提示', c.includes('if (hiddenTotal === 0) return null'))

console.log('')
console.log('════════ B. 探测记录 keyId 条件归一化 ════════')
ok('先取 rawKey', u.includes("const rawKey = String(rec.keyId ?? 'anonymous')"))
ok('只在 rawKey 为 anonymous 时归一', u.includes("rawKey === 'anonymous'\n      ? 'internal'"))
ok('否则保留原 keyId', u.includes(': rawKey'))

console.log('')
console.log('════════ C. 导出脱敏不误伤 ════════')
ok('BENIGN_KEY_HINT 存在', r.includes('const BENIGN_KEY_HINT'))
ok('ID_LIKE_KEY 存在', r.includes('const ID_LIKE_KEY'))
ok('键名判定排除无害词', r.includes('SENSITIVE_KEY.test(keyHint) && !BENIGN_KEY_HINT.test(keyHint)'))
ok('高熵兜底避开 ID 字段', r.includes('!ID_LIKE_KEY.test(keyHint)'))
// 真实行为：从源码提取常量 + 函数
{
  const grab = (re) => { const m = re.exec(r); return m ? m[0] : '' }
  const consts = [
    grab(/const SENSITIVE_KEY = \/[^\n]+\/i/),
    grab(/const BENIGN_KEY_HINT = \/[^\n]+\/i/),
    grab(/const ID_LIKE_KEY = \/[^\n]+\/i/),
  ]
  const fn = grab(/function scrubStringValues\(o, keyHint = ''\) \{[\s\S]*?\n\}/)
  if (consts.some((x) => !x) || !fn) ok('能提取 scrubStringValues', false)
  else {
    const scrub = new Function(`${consts.join('; ')}; ${fn}; return scrubStringValues`)()
    const input = {
      Authorization: 'rawsecretvalue000', accessToken: 'rawaccesstoken',
      skBare: 'sk-abcdefgh12345678', highEntropy: 'AbCdEf1234567890XyZabcdef',
      keyword: 'someKeywordValue', monkey: 'harmless', sessionId: 'sess-1',
      keyId: 'key_3339fed6', tokenizer: 'cl100k_base', keyPrint: 'e6af3812',
      projectId: 'Kx9pQ2vL7mN4bR8tY1wZ5cH3jD6fS0gA',
      clientId: 'Ab3Cd9Ef2Gh4Ij5Kl6Mn7Op8Qr9St0Uv',
      modelName: 'Gpt4Turbo2024PreviewAb3Cd9Ef2Gh4Ij5Kl6Mn7Op8',
    }
    const out = scrub(input)
    ok('真凭证仍被擦', ['Authorization', 'accessToken', 'skBare', 'highEntropy'].every((k) => out[k] === '***'))
    ok('无害字段名不误伤', ['keyword', 'monkey', 'sessionId', 'keyId', 'tokenizer', 'keyPrint'].every((k) => out[k] === input[k]))
    ok('ID 型键名的高熵值不误伤', ['projectId', 'clientId', 'modelName'].every((k) => out[k] === input[k]))
    ok('原对象未被修改', input.Authorization === 'rawsecretvalue000')
  }
}

console.log('')
console.log('════════ D. 匿名哨兵 ════════')
ok('breaker.js 无 __anonymous__', !b.includes('__anonymous__'))
ok('index.js 无 __anonymous__', !i.includes('__anonymous__'))

console.log('')
console.log('════════ E. 三个聚合器判空 ════════')
for (const [label, src] of [['OpenAi', p], ['Responses', rs], ['Anthropic', a]]) {
  ok(`${label} hasUsableTool()`, src.includes('hasUsableTool()'))
  ok(`${label} isEmpty 用它`, src.includes('!this.hasUsableTool()') || src.includes('if (this.hasUsableTool()) return false'))
}
ok('isReasoningOnly 未被改动（仍按 tools.size）',
  p.includes('this.tools.size === 0 && this.reasoning.length > 0')
  && rs.includes('this.tools.size === 0 && this.reasoning.length > 0'))

console.log('')
console.log('════════ F. 冷却标签区分 ════════')
ok('限流冷却秒数', c.includes("'限流冷却秒数'"))
ok('后端冷却秒数', c.includes("'后端冷却秒数'"))
ok('不再有两处裸「冷却秒数」', !c.includes("}, '冷却秒数')"))

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0