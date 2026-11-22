/**
 * test-input-validation.mjs — 三条通道的入参校验必须一致（源码级）。
 *
 * 为什么用源码断言而不是打 HTTP：
 *   插件是 ESM 模块，进程启动时一次性加载，改完不重启就验不到新行为。
 *   而「同一个畸形请求在三条通道上给出不同的码」这类缺陷，恰恰最容易
 *   在"改了一条忘了另外两条"时发生 —— 它需要的是**结构断言**（三条通道
 *   都有这段校验），不是某一次 HTTP 的返回码。
 *
 * 覆盖的三条通道：
 *   chat      → lib/index.js  handleOpenAIChat 内的 failJson 校验
 *   anthropic → lib/anthropic.js validateAnthropicRequest
 *   responses → lib/responses.js parseResponsesRequest
 */
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const ROOT = `${LANTERN_DIR}/lib`
const index = readFileSync(ROOT + '/index.js', 'utf8')
const anthropic = readFileSync(ROOT + '/anthropic.js', 'utf8')
const responses = readFileSync(ROOT + '/responses.js', 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra)) }
}

console.log('\n【V1 缺 model：三条通道都要 400，不能 404】')
{
  // chat 曾经直接掉进 resolveModel → 404 model_not_found，
  // 客户端按 404 会以为"模型下线了"去做重试/切换，实际只是少写一个字段。
  //
  // 第二轮重构：chat 不再内联写 model 判断，而是把结构校验整体交给
  // `validateChatRequest`（lib/protocol.js）——这样 messages 也有同一道闸。
  // 于是断言从"内联那行在不在"改为"接线是否正确"：
  //   1) chat handler 调了 validateChatRequest
  //   2) 拿到的那句错误原文进了 failJson（不是换了个通用文案）
  //   3) 码与类型仍是 bad_request / invalid_request_error（与另两条通道对齐）
  check('V1a chat 走 validateChatRequest', /const invalid = validateChatRequest\(body\)/.test(index), '')
  check('V1b chat 把校验器的原文交给 failJson', /failJson\(400, invalid, 'invalid_request_error', 'bad_request'/.test(index), '')
  check('V1c anthropic 有"缺少 model 字段"', anthropic.includes("'缺少 model 字段'"), '')
  check('V1d responses 抛"缺少 model 字段"', /throw new Error\('缺少 model 字段'\)/.test(responses), '')
  // 缺 model 的文案由校验器产出（protocol.js），chat 只是转发它
  const protocol = readFileSync(ROOT + '/protocol.js', 'utf8')
  check('V1e 缺 model 的文案在 protocol.js 里', protocol.includes("'缺少 model 字段'"), '')
  check('V1f chat 不再内联写 model 判断（避免两套口径）', !/if \(typeof body\.model !== 'string' \|\| body\.model\.trim\(\)\.length === 0\) \{\s*\n\s*failJson/.test(index), '')
}

console.log('\n【V2 max_tokens 必须为正整数：三条通道都要挡】')
{
  // 真实漏洞：Math.min(-1, 8192) 还是 -1，负数会原样流到上游；
  // 上游有的钳掉有的忽略 → 同一个畸形请求在不同后端上表现不同。
  //
  // 第二轮收紧（第二轮全量排查）：只判 `> 0` 会放行 `8.7`（上游判 integer）
  // 与 `1e999`（JSON.parse 后是 Infinity，`Infinity > 0` 为真）——两者都
  // 会让上游报错却被算在网关头上。统一用 `Number.isSafeInteger`。
  // 文案是动态拼的（'<字段名> 必须是正整数'），所以断言语义而不是字面量：
  // 必须存在 Number.isSafeInteger 守卫 + 一条以字段名开头的正整数提示。
  check('V2a chat 有正整数校验（文案随字段名）', /limitField \+ ' 必须是正整数'/.test(index) || index.includes("'max_tokens 必须是正整数'"), '')
  check('V2a2 chat 同时接受 max_tokens 与 max_completion_tokens', index.includes('body.max_completion_tokens'), '')
  check('V2b chat 用 Number.isSafeInteger 挡小数/Infinity', /max_tokens[\s\S]{0,220}?Number\.isSafeInteger/.test(index), '')
  check('V2c chat 校验在封顶之前', index.indexOf("'max_tokens 必须是正整数'") < index.indexOf('Math.min(requestedMax, maxTokensCap)'), '')
  check('V2d anthropic 有 max_tokens 正整数校验', anthropic.includes("'max_tokens 必须是正整数'"), '')
  check('V2e responses 有 max_output_tokens 正整数校验', responses.includes("'max_output_tokens 必须是正整数'"), '')
  check('V2f responses 也挡小数/Infinity', /max_output_tokens[\s\S]{0,260}?Number\.isSafeInteger/.test(responses), '')
  // responses 的校验必须抛错（被 handler 的 try/catch 变成 400），而不是静默忽略
  check('V2g responses 用 throw（由 handler 转 400）', /max_output_tokens 必须是正整数'\)/.test(responses), '')
  // 三条通道口径必须一致：不能一处要求正整数、另一处还停在"正数"
  check('V2h 三条通道都留有旧文案（不该有残留）', !index.includes("'max_tokens 必须是正数'") && !anthropic.includes("'max_tokens 必须是正数'") && !responses.includes("'max_output_tokens 必须是正数'"), '')
}

console.log('\n【V3 不许出现"负数静默通过"的老写法】')
{
  // 老写法：`typeof body.max_tokens === 'number' ? ... : undefined` 会把 -1 当成合法数字。
  // 现在要求：真正**取值**的那一行（const requestedMax = ...）必须出现在正值校验之后。
  // 只看"出现过 typeof"是不够的——校验语句自己就写着 typeof，
  // 关键是求值顺序（V2c 已单独断言，这里再从取值行验证一次）。
  // 归一化赋值（body.max_tokens = limitValue）必须在校验之后：
  // 否则畸形值会先被写到 body 上，再被后面的逻辑当成"用户填的合法值"。
  const normalizeLine = index.split('\n').findIndex((l) => l.includes('body.max_tokens = limitValue'))
  const guardLine2 = index.split('\n').findIndex((l) => l.includes('Number.isSafeInteger(limitValue)'))
  check('V3a chat 的归一化赋值在校验之后', normalizeLine > guardLine2 && guardLine2 > 0, 'guard=' + guardLine2 + ' norm=' + normalizeLine)
  check('V3b responses 的 maxOutputTokens 取值前已有前置校验', responses.indexOf("'max_output_tokens 必须是正整数'") < responses.indexOf('maxOutputTokens: typeof body.max_output_tokens'), '')
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
