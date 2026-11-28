#!/usr/bin/env node
/**
 * 守卫：诊断导出的脱敏不能只按「值形态」判。
 *
 * 真实发现：scrubStringValues 原来
 *   1. `/^(Bearer|Basic|Token)\s+…/i` 的 ^ 锚点让句中的 Bearer 令牌漏擦
 *   2. 只看值不看键名 → `X-Api-Key: "rawtoken"` 这类原样导出
 * 诊断包是发给别人看的，等于把凭证一起送出去。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'rpc.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

console.log('════════ A. 源码形状 ════════')
ok('有 SENSITIVE_KEY 常量', src.includes('const SENSITIVE_KEY'))
ok('Bearer 正则无 ^ 锚点', !src.includes('/^(Bearer|Basic|Token)') && src.includes('\\b(?:Bearer|Basic|Token)'))
ok('函数接收 keyHint', src.includes("function scrubStringValues(o, keyHint = '')"))
ok('键名命中即打码', /SENSITIVE_KEY\.test\(keyHint\)/.test(src))
ok('递归传子键名', src.includes('scrubStringValues(v, k)'))
ok('数组沿用父键名', src.includes('scrubStringValues(v, keyHint)'))

console.log('')
console.log('════════ B. 真实运行行为 ════════')
{
  const grab = (re) => { const m = re.exec(src); return m ? m[0] : '' }
  const consts = [
    grab(/const SENSITIVE_KEY = \/[^\n]+\/i/),
    grab(/const BENIGN_KEY_HINT = \/[^\n]+\/i/),
    grab(/const ID_LIKE_KEY = \/[^\n]+\/i/),
  ]
  const fnM = /function scrubStringValues\(o, keyHint = ''\) \{[\s\S]*?\n\}/.exec(src)
  if (consts.some((x) => !x) || !fnM) {
    ok('能从源码提取函数与常量', false)
  } else {
    // scrubStringValues 现在依赖三个常量，必须一并注入
    const scrub = new Function(`${consts.join('; ')}; ${fnM[0]}; return scrubStringValues`)()
    const input = {
      skBare: 'sk-abcdefgh12345678',
      bearerValue: 'Bearer abc123XYZ999',
      urlCred: 'https://user:pass@host.example/api',
      midBearer: 'the credential is Bearer abc123XYZ999 here',
      sensitiveNamed: { Authorization: 'rawsecretvalue000', 'X-Secret': 'shhh111' },
      highEntropy: 'AbCdEf1234567890XyZabcdef',
      // 正常配置不该被误伤
      limits: { cooldownSec: 30 },
      auth: { format: 'sk', allowAnonymous: false },
      customModels: [{ name: 'hy4', bindings: ['a@provider'] }],
      base64Icon: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      lowercase: 'myrawplaintexttoken12345678',
    }
    const out = scrub(input)
    ok('裸 sk-… 被擦', out.skBare === '***')
    ok('Bearer 值被擦', out.bearerValue === '***')
    ok('URL 内嵌凭证被擦', out.urlCred === '***')
    ok('句中 Bearer 被擦（原绕过）', out.midBearer === '***', out.midBearer)
    ok('敏感键名的值被擦（原绕过）', out.sensitiveNamed.Authorization === '***' && out.sensitiveNamed['X-Secret'] === '***', out.sensitiveNamed)
    ok('高熵裸 token 被擦（兜底）', out.highEntropy === '***', out.highEntropy)
    ok('标准 base64 图标不被误伤', out.base64Icon === input.base64Icon, out.base64Icon)
    ok('UUID 不被误伤', out.uuid === input.uuid)
    ok('普通小写串保留（启发式边界）', out.lowercase === input.lowercase)
    ok('limits 结构保留', JSON.stringify(out.limits) === JSON.stringify(input.limits))
    ok('auth 段保留', JSON.stringify(out.auth) === JSON.stringify(input.auth))
    ok('customModels 保留', JSON.stringify(out.customModels) === JSON.stringify(input.customModels))
    ok('原对象未被修改', input.skBare === 'sk-abcdefgh12345678')
  }
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0