// 第十轮回归护栏：九条修复的"源码级 + 真执行"双重钉死。
//
// 为什么每一条都要有断言：
//   #103 不传档位 400 —— 这条曾经把三条协议里的两条全打死，而当时 1017 项断言全绿。
//        缺的就是"完全不传"这一态的断言。
//   #104 off 打空链 —— off 与 none 同 rank（都是 0），字面匹配会把整条链清空。
//   #105 非流式 usage 从不采集 —— 账本 100% 缺字段，熔断器 token 计量恒 0。
//   #106 responses 读 cachedInputTokens（DSH 里不存在的字段）—— 缓存折算全丢。
//   #107 responses 的 failJson 少一个形参 —— extra 被静默丢弃。
//   #108 warnings 全链路被丢 —— 降级不可见。
//   #109 MAX_MESSAGES 截断方向反了 —— 丢掉最新提问。
//   #110 thinking=disabled 三方口径打架。
//
// 读源码的方式：**不剥离注释**。块注释正则会吞掉代码（实测把 rpc.js 啃掉
// 23020 字节），逐行剥行注释又会误伤字符串里的 URL。所以每条断言都匹配
// 带上下文的完整语句，而不是裸标识符。
//
// 本文件内任何注释都不得出现"星号紧跟斜杠"的二字连排 —— 那会提前终结块注释，
// 导致整个脚本 SyntaxError（本轮踩了两次）。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}/lib/`
const idx = readFileSync(P + 'index.js', 'utf8')
const proto = readFileSync(P + 'protocol.js', 'utf8')
const resp = readFileSync(P + 'responses.js', 'utf8')
const anth = readFileSync(P + 'anthropic.js', 'utf8')
const call = readFileSync(P + 'call-contract.js', 'utf8')

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

console.log('=== R103 不传档位必须早退（不是 400）===')
{
  const mod = await import('file:///' + P + 'effort-contract.js')
  t('R103a toContractLevel(undefined) 返回 undefined（"没传"的表示）',
    mod.toContractLevel(undefined) === undefined)
  // 第十轮第二版把三个"没传"的形态合并成了一条早退（同时支持按模型的默认档）。
  // 断言要匹配**合并后**的实际写法，而不是第一版的两行式 —— 否则代码改好了、测试变红。
  const earlyReturn =
    'if (requested === undefined || requested === null || (typeof requested === \'string\' && requested.trim().length === 0))'
  t('R103b index.js 有 undefined/null 早退', idx.includes(earlyReturn),
    idx.includes("if (requested === undefined || requested === null)") ? '匹配到旧形式' : '未找到')
  t('R103c 空串/全空白也在同一条早退里', earlyReturn.includes('requested.trim().length === 0'))
  t('R103e 早退后若有默认档则用它', idx.includes("headers['X-Lantern-Effort-Source'] = 'model-default'"))
  t('R103d 早退发生在 toContractLevel 之前（源码顺序）',
    idx.indexOf('requested === undefined || requested === null') < idx.indexOf('const contract = toContractLevel(requested)'))
}

console.log('\n=== R104 off/none 必须同档（按 rank，不按字面）===')
{
  const mod = await import('file:///' + P + 'effort-contract.js')
  t('R104a rankOf(off) === rankOf(none) === 0',
    mod.rankOf('off') === 0 && mod.rankOf('none') === 0 && mod.rankOf('off') === mod.rankOf('none'))
  t('R104b rankOf(xhigh)=7 != rankOf(high)=5（xhigh 到 high 的保护必须保留）',
    mod.rankOf('xhigh') === 7 && mod.rankOf('high') === 5)
  t('R104c effortState 用 rankOf 相等判定',
    idx.includes('const targetRank = rankOf(wantEffort)') && idx.includes('list.some((e) => rankOf(e) === targetRank)'))
  t('R104d 无法分级时仍退回字面匹配', idx.includes('const hit = list.some((e) => e === wantEffort)'))
  t('R104e anthropic disabled 也按 rank===0 找关闭档',
    proto.includes('const off = efforts.find((e) => rankOf(e) === 0)'))
  t('R104f protocol.js 已导入 rankOf', proto.includes("import { rankOf"))
}

console.log('\n=== R105 非流式 usage 必须被采集 ===')
{
  const count = (idx.match(/state\.usage = chunk\.usage/g) ?? []).length
  t('R105a 流式与非流式两处都在（恰好 2 次）', count === 2, 'count=' + count)
  t('R105b 非流式那处紧邻 aggregator.push',
    /if \(chunk\?\.type === 'usage'\) state\.usage = chunk\.usage[\s\S]{0,600}aggregator\.push\(chunk\)/.test(idx))
}

console.log('\n=== R106 responses 缓存字段名必须与 DSH 一致 ===')
{
  t('R106a 读 cacheReadTokens', resp.includes('Number(usage.cacheReadTokens)'))
  // 只判**赋值语句**：注释里引用了旧字段名（说明"曾经写错过"），不能算代码残留。
  t('R106b 代码里不再有 cachedInputTokens 的读取',
    !/const cached = Number\(usage\.cachedInputTokens\)/.test(resp) &&
    !/usage\?\.cachedInputTokens !== undefined/.test(resp))
  t('R106c cached_tokens 明细也用 cacheReadTokens',
    resp.includes('cacheReadTokens !== undefined ? { cached_tokens: chunk.usage.cacheReadTokens }'))
}

console.log('\n=== R107 responses 的 failJson 必须收 extra ===')
{
  t('R107a 形参含 extra = {}',
    idx.includes("const failJson = (status, message, type = 'invalid_request_error', code = 'bad_request', extra = {})"))
  t('R107b 透传给 errorBody',
    /errorBody\(publicMessage\(maskSecrets\(message\), cfg\), type, code, extra\)/.test(idx))
}

console.log('\n=== R108/R109 消息降级必须可见 + 保留最新 ===')
{
  t('R108a applyMessageWarnings 已定义', idx.includes('function applyMessageWarnings(res, built, cfg)'))
  const calls = (idx.match(/(?<!function )applyMessageWarnings\(res, built/g) ?? []).length
  t('R108b 三个协议调用点都接了（chat/anthropic/responses）', calls === 3, 'calls=' + calls)
  t('R108c 写 X-Lantern-Warnings', idx.includes("res.setHeader('X-Lantern-Warnings'"))
  t('R109a chat 保留尾部', proto.includes('keptMessages = truncated ? rawMessages.slice(-MAX_MESSAGES)'))
  t('R109b anthropic 保留尾部', anth.includes('keptMessages = truncated ? rawMessages.slice(-MAX_MESSAGES)'))
  // 只判**实际调用形态**：注释里引用了旧写法（说明"曾经从头部截"），不能算残留。
  t('R109c 代码里不再用 slice(0, MAX_MESSAGES) 截断',
    !/rawMessages\.slice\(0, MAX_MESSAGES\)/.test(proto) &&
    !/rawMessages\.slice\(0, MAX_MESSAGES\)/.test(anth))
  t('R109d 警告文案说明丢弃的是最早的',
    proto.includes('丢弃最早的') && anth.includes('丢弃最早的'))
}

console.log('\n=== R110 thinking=disabled 三方口径自洽 ===')
{
  t('R110a index.js 不再把 disabled 硬编码成 minimal',
    !/type === 'disabled'\s*\n?\s*\?\s*'minimal'/.test(idx))
  t('R110b disabled 与 enabled 共用 thinkingMap.value',
    /\(body\.thinking\.type === 'disabled' \|\| body\.thinking\.type === 'enabled'\)[\s\S]{0,60}\? thinkingMap\.value/.test(idx))
  t('R110c 关不掉时补 dropped',
    /effortWord === undefined[\s\S]{0,120}thinkingMap\.dropped\.push\('thinking'\)/.test(idx))
  t('R110d thinkingMap 在 thinkingContract 之前算完',
    idx.indexOf('const thinkingMap = resolveAnthropicThinking') < idx.indexOf('const thinkingContract ='))
}

console.log('\n=== R-S1 stop 截断必须可见 ===')
{
  t('R-S1a clipStopSequences 已接入', idx.includes('const stopClip = clipStopSequences(body.stop)'))
  t('R-S1b 截断写头', idx.includes('X-Lantern-Stop-Truncated'))
  t('R-S1c call-contract 的 stop 上限是 4', /stop: Object\.freeze\(\{ min: 0, max: 4/.test(call))
}

console.log('\n=== R-S2 软参数必须按并集判 ===')
{
  t('R-S2a 软参数并集覆盖已实装', /for \(const softField of \['temperature', 'stop'\]\)/.test(idx))
  t('R-S2b 判据是"任一档 supported 即下发"', idx.includes('values.includes(VALUE.supported)'))
}

console.log('\n=== R-T1 temperature 必须封顶 ===')
{
  t('R-T1a 用 clampScalar 而不是原样透传', idx.includes("clampScalar('temperature', body.temperature)"))
  t('R-T1b call-contract 的 temperature 区间 0-2', /temperature: Object\.freeze\(\{ min: 0, max: 2/.test(call))
}

console.log('\n=== R-C1 新增响应头必须在 CORS 暴露表里 ===')
{
  for (const h of [
    'X-Lantern-Effort-Contract', 'X-Lantern-Effort-Served', 'X-Lantern-Effort-Note',
    'X-Lantern-Served', 'X-Lantern-Attempts',
    'X-Lantern-Warnings', 'X-Lantern-Warning-Texts', 'X-Lantern-Stop-Truncated',
  ]) t('R-C1 ' + h, idx.includes("'" + h + "'"))
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
