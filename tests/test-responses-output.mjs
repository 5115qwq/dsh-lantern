import { LANTERN_DIR } from './paths.mjs'
/**
 * test-responses-output.mjs — Responses 通道「最终响应体」的回归护栏。
 *
 * 起因（第八轮真机验收抓到的两条真缺陷）：
 *   1. 非流式响应没有顶层 `output_text`。OpenAI 服务端会返这个字段，而大量客户端
 *      （Codex CLI、shell 脚本、手写 fetch）就是读 `body.output_text`。
 *      缺了它，调用明明成功、正文也躺在 output[].content[].text 里，
 *      客户端拿到的却是 undefined → 表现为「模型没说话」。
 *   2. 流式 `response.completed.response.output` 被写死成 `[]`。
 *      只读终态事件（不自己拼增量）的客户端拿到空回答；
 *      同一句话在 stream=false 时有内容、stream=true 时没有。
 *
 * 这两条都属于「最容易被当成网关坏了」的分叉，所以两边都用同一份 buildOutputItems。
 *
 * 跑法：node test-responses-output.mjs
 */

const P = `file:///${LANTERN_DIR}/lib/responses.js`
const { ResponsesAggregator, ResponsesStreamTranslator } = await import(P)

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' — ' + extra))
  }
}
const parseFrame = (frame) => {
  const line = String(frame).split('\n').find((one) => one.startsWith('data: '))
  return line === undefined ? undefined : JSON.parse(line.slice('data: '.length))
}

console.log('R1 非流式：顶层 output_text / output 数组形状')
{
  const agg = new ResponsesAggregator({ id: 'resp_1', model: 'glm-5.3' })
  agg.push({ type: 'text-delta', text: '{"name": "张伟"}' })
  agg.push({ type: 'finish', reason: { kind: 'stop' } })
  const body = agg.end()
  ok('output_text 是正文字符串', body.output_text === '{"name": "张伟"}', JSON.stringify(body.output_text))
  ok('output_text 与 output[0].content[0].text 一致', body.output[0]?.content?.[0]?.text === body.output_text)
  ok('output_text 可被 JSON.parse（json_schema 客户端的实际用法）', JSON.parse(body.output_text).name === '张伟')
  ok('object=response / status=completed', body.object === 'response' && body.status === 'completed')
  ok('id 与 model 原样带出', body.id === 'resp_1' && body.model === 'glm-5.3')
  ok('没有多塞 error / incomplete_details', body.error === undefined && body.incomplete_details === undefined)
}

console.log('R2 非流式：只调工具时不能伪装成"说了空白"')
{
  const agg = new ResponsesAggregator({ id: 'resp_2', model: 'glm-5.3' })
  agg.push({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"北京"}' })
  agg.push({ type: 'finish', reason: { kind: 'stop' } })
  const body = agg.end()
  ok('output_text 为空串（不是 undefined）', body.output_text === '')
  ok('message.content 为空数组', Array.isArray(body.output[0].content) && body.output[0].content.length === 0)
  ok('带出 function_call 项', body.output.some((item) => item.type === 'function_call'))
  ok('function_call 参数完整', body.output.find((item) => item.type === 'function_call')?.arguments === '{"city":"北京"}')
  ok('isEmpty() 对纯工具调用为 false', agg.isEmpty() === false)
}

console.log('R3 非流式：推理内容单独成项，不进 output_text')
{
  const agg = new ResponsesAggregator({ id: 'resp_3', model: 'glm-5.3' })
  agg.push({ type: 'reasoning-delta', text: '先想一想' })
  agg.push({ type: 'text-delta', text: '你好' })
  agg.push({ type: 'finish', reason: { kind: 'stop' } })
  const body = agg.end()
  ok('output_text 只含正文', body.output_text === '你好')
  const reasoning = body.output.find((item) => item.type === 'reasoning')
  ok('reasoning 项存在且带 summary_text', reasoning?.summary?.[0]?.text === '先想一想')
}

console.log('R4 流式：终态 response.completed 必须带正文')
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_4', model: 'glm-5.3', sanitize: (x) => x })
  tr.push({ type: 'text-delta', text: '你好' })
  tr.push({ type: 'finish', reason: { kind: 'stop' } })
  const frames = tr.end()
  const completed = frames.filter((f) => f.startsWith('event: response.completed'))
  ok('恰好一帧 response.completed', completed.length === 1)
  const body = parseFrame(completed[0])?.response
  ok('completed.response.output_text 有正文', body?.output_text === '你好', JSON.stringify(body?.output_text))
  ok('completed.response.output 非空', Array.isArray(body?.output) && body.output.length > 0)
  ok('completed 与非流式同结构', body?.output?.[0]?.content?.[0]?.text === '你好')
  ok('completed.response.status=completed', body?.status === 'completed')
}

console.log('R5 流式：output_item.done 是权威快照')
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_5', model: 'glm-5.3', sanitize: (x) => x })
  tr.push({ type: 'text-delta', text: '甲乙丙' })
  tr.push({ type: 'finish', reason: { kind: 'stop' } })
  const frames = tr.end()
  const done = frames.filter((f) => f.startsWith('event: response.output_item.done'))
  ok('恰好一帧 output_item.done', done.length === 1)
  const item = parseFrame(done[0])?.item
  ok('item.type=message', item?.type === 'message')
  ok('item.content[0].text 完整', item?.content?.[0]?.text === '甲乙丙')
  ok('output_index 是 0', parseFrame(done[0])?.output_index === 0)
}

console.log('R6 流式：增量事件仍然逐段发出（改动没有把增量吃掉）')
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_6', model: 'glm-5.3', sanitize: (x) => x })
  const first = tr.push({ type: 'text-delta', text: '一' })
  const second = tr.push({ type: 'text-delta', text: '二' })
  const deltas = [...first, ...second].filter((f) => f.startsWith('event: response.output_text.delta'))
  ok('两次 push 各发一帧 delta', deltas.length === 2)
  ok('delta 内容逐段正确', parseFrame(deltas[0])?.delta === '一' && parseFrame(deltas[1])?.delta === '二')
  const done = tr.end().filter((f) => f.startsWith('event: response.output_text.done'))
  ok('output_text.done 汇总为全文', parseFrame(done[0])?.text === '一二')
}

console.log('R7 流式：失败时发 response.failed，绝不伪装成完成')
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_7', model: 'm', sanitize: (x) => x })
  tr.push({ type: 'text-delta', text: '半句' })
  tr.markFailed({ code: 'upstream_error', message: '上游挂了' })
  const frames = tr.end()
  ok('有 response.failed', frames.some((f) => f.startsWith('event: response.failed')))
  ok('没有 response.completed', !frames.some((f) => f.startsWith('event: response.completed')))
  const failed = frames.find((f) => f.startsWith('event: response.failed'))
  ok('failed 里带 error.code', parseFrame(failed)?.response?.error?.code === 'upstream_error')
}

console.log('R8 截断：status=incomplete + incomplete_details，但正文照样给')
{
  const agg = new ResponsesAggregator({ id: 'resp_8', model: 'glm-5.3' })
  agg.push({ type: 'text-delta', text: '被截断的' })
  agg.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  const body = agg.end()
  ok('status=incomplete', body.status === 'incomplete')
  ok('incomplete_details.reason=max_output_tokens', body.incomplete_details?.reason === 'max_output_tokens')
  ok('截断也保留已产出的正文', body.output_text === '被截断的')
}

console.log('R9 流式：终态快照也要带上推理与工具调用（不然「只想不说话」等于什么都没做）')
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_9', model: 'glm-5.3', sanitize: (x) => x })
  tr.push({ type: 'reasoning-delta', text: '想一想' })
  tr.push({ type: 'text-delta', text: '答案' })
  tr.push({ type: 'finish', reason: { kind: 'stop' } })
  const frames = tr.end()
  const body = parseFrame(frames.find((f) => f.startsWith('event: response.completed')))?.response
  ok('终态里既有一 message 项也有一 reasoning 项', Array.isArray(body?.output) && body.output.length === 2, JSON.stringify(body?.output?.map((i) => i.type)))
  ok('reasoning.summary[0].text 完整', body?.output?.find((i) => i.type === 'reasoning')?.summary?.[0]?.text === '想一想')
  ok('output_text 只含正文不含推理', body?.output_text === '答案')
}
{
  const tr = new ResponsesStreamTranslator({ id: 'resp_10', model: 'glm-5.3', sanitize: (x) => x })
  tr.push({ type: 'tool-call-delta', index: 0, id: 'call_9', name: 'get_weather', argumentsDelta: '{"city":' })
  tr.push({ type: 'tool-call-delta', index: 0, argumentsDelta: '"上海"}' })
  tr.push({ type: 'finish', reason: { kind: 'stop' } })
  const frames = tr.end()
  const body = parseFrame(frames.find((f) => f.startsWith('event: response.completed')))?.response
  const call = body?.output?.find((i) => i.type === 'function_call')
  ok('终态带 function_call 项', call !== undefined)
  ok('参数跨 chunk 拼接完整', call?.arguments === '{"city":"上海"}', JSON.stringify(call?.arguments))
  ok('只调工具时 output_text 是空串', body?.output_text === '')
}

console.log('')
console.log('==== ' + pass + ' passed / ' + fail + ' failed ====')
if (fail > 0) process.exitCode = 1
