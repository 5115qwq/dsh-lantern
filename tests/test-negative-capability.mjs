/**
 * 负能力学习规则（detectNegativeCapability）的回归护栏。
 *
 * 背景：这一组正则决定「一次上游报错要不要被**永久**记成"该模型不支持某能力"」。
 * 记错代价极高——它写进 data/capabilities.json，之后所有相关请求都被拒，
 * 而且用户看不出这个结论从哪来。原实现 23 条真实文案里误判 5 条（22%）：
 *   - 只要出现 "stop sequence" 就判不支持 stop（值太长/类型错都中招）
 *   - image format / image size not supported 被判成"不支持图片"
 * 所以这里把「必须命中」与「必须不命中」两侧都钉死。
 */
import { detectNegativeCapability } from '../lib/capabilities.js'

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
const expect = (msg, want) => {
  const got = detectNegativeCapability(msg)
  const label = msg === undefined ? 'undefined' : JSON.stringify(msg).slice(0, 60)
  check(label + ' → ' + (want ?? 'undefined'), (got ?? undefined) === want, 'got ' + (got ?? 'undefined'))
}

console.log('【A 参数「值/格式」错误绝不能记成能力缺失】')
expect('The stop sequence is too long, max 4 sequences', undefined)
expect('Invalid stop sequence: must be an array of strings', undefined)
expect('stop sequence must not be empty', undefined)
expect('stop sequences 数量超过上限', undefined)
expect('temperature must be between 0 and 2', undefined)
expect('temperature 值无效：必须在 0 到 2 之间', undefined)
expect('temperature out of range [0,2]', undefined)
expect('image format not supported, only png/jpeg', undefined)
expect('image size not supported, max 2048x2048', undefined)
expect('unsupported image mime type: image/webp', undefined)
expect('reasoning effort must be one of low/medium/high', undefined)
expect('response_format 必须同时提供 json_schema', undefined)
expect('tools must be an array', undefined)
expect('parallel_tool_calls is only allowed when tools are provided', undefined)

console.log('\n【B 与能力无关的失败不能记（否则等于随机禁用）】')
expect('Rate limit exceeded, please retry', undefined)
expect('Context length exceeded', undefined)
expect('Max tokens exceeded', undefined)
expect('Internal server error', undefined)
expect('Request timeout after 30s', undefined)
expect('', undefined)
expect(undefined, undefined)

console.log('\n【C 真的是「不支持」必须命中】')
expect('This model does not support tools', 'tools')
expect('tools are not supported for this model', 'tools')
expect('function calling is not supported', 'tools')
expect('No tool call support for this endpoint', 'tools')
expect('response_format is not supported', 'jsonMode')
expect('json mode not supported', 'jsonMode')
expect('temperature is not supported', 'temperature')
expect("Unsupported parameter: 'temperature'", 'temperature')
expect('unsupported temperature', 'temperature')
expect('stop sequences not supported', 'stop')
expect('this model doesn\'t support stop', 'stop')
expect("Unsupported parameter: 'reasoning'", 'reasoning')
expect('Unsupported parameter: reasoning', 'reasoning')
expect('reasoning_effort is not supported', 'reasoning')
expect('parallel tool calls not supported', 'parallelTools')
expect('This model does not support image input', 'image')
expect('vision is not supported', 'image')
expect('image input not supported', 'image')
expect('this endpoint is text only', 'image')

console.log('\n【D 大小写与全角标点（上游文案不统一）】')
expect('THIS MODEL DOES NOT SUPPORT TOOLS', 'tools')
expect('Unsupported parameter：reasoning', 'reasoning')

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)

