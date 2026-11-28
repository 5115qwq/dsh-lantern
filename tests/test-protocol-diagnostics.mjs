#!/usr/bin/env node
/**
 * 守卫：三条协议的诊断头与空产出自救必须一致。
 *
 * 真实网络调用发现（1.1.3 验证轮）：
 *   1. /v1/messages 与 /v1/responses 的**非流式成功路径**完全没有
 *      X-Lantern-Served / Attempts / Attempt-Codes 三个头（chat 通道有）
 *   2. budget_boosted 是同一后端换预算重试，却被算进 attempts →
 *      hy4（5 档）对外报「已尝试 6 个上游」，且 #N 与 Served 坐标错位
 *   3. AnthropicAggregator 缺 isReasoningOnly()，导致 /v1/messages 在
 *      推理模型 + 小预算下无法触发「放大预算自救」，handler 层直接 503，
 *      而同参数的 /v1/chat/completions 能成功
 *   4. Responses 的 200 + status:incomplete + 空 output_text 会被当成正常交付
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')
const index = readFileSync(join(LIB, 'index.js'), 'utf8')
const anthropic = readFileSync(join(LIB, 'anthropic.js'), 'utf8')
const responses = readFileSync(join(LIB, 'responses.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

console.log('════════ A. 诊断头对外口径 ════════')
ok('attempts 过滤 budgetBoosted', index.includes("rawAttempts.filter((a) => a?.budgetBoosted !== true)"))
ok('Attempts 头用过滤后长度（两处）',
  (index.match(/attemptList\.length > 0\) res\.setHeader\('X-Lantern-Attempts'/g) ?? []).length === 2)
ok('Attempt-Codes 用过滤后的 attemptList', /const codes = attemptList\.map/.test(index))

console.log('')
console.log('════════ B. 三条协议非流式都写诊断头 ════════')
ok('chat', /applyServedHeaders\(res, fo2, plansReady/.test(index))
ok('anthropic', /applyServedHeaders\(res, fo2, anthReady/.test(index))
ok('responses', /applyServedHeaders\(res, fo2, respReady/.test(index))

console.log('')
console.log('════════ C. 三个聚合器都有 isReasoningOnly ════════')
ok('OpenAiAggregator (protocol.js)', readFileSync(join(LIB, 'protocol.js'), 'utf8').includes('isReasoningOnly()'))
ok('AnthropicAggregator', anthropic.includes('isReasoningOnly()'))
ok('ResponsesAggregator', responses.includes('isReasoningOnly()'))
ok('Anthropic 实现考虑 current 缓冲', /isReasoningOnly\(\) \{[\s\S]{0,700}consider\(this\.current\)/.test(anthropic))
ok('Anthropic 实现考虑 toolBlocks', /isReasoningOnly\(\) \{[\s\S]{0,900}toolBlocks/.test(anthropic))

console.log('')
console.log('════════ D. Responses 空产出判据 ════════')
ok('含 status:incomplete 判定', index.includes("String(body0?.status ?? '') === 'incomplete'"))
ok('含 output_text 汇总', index.includes("o?.type === 'output_text'"))

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0