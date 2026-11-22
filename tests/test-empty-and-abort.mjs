import fs from 'node:fs'
import { LANTERN_DIR } from './paths.mjs'
import assert from 'node:assert/strict'

let pass = 0; let fail = 0
const t = (name, fn) => { try { fn(); pass += 1; console.log('  PASS  ' + name) } catch (e) { fail += 1; console.log('  FAIL  ' + name + ' :: ' + e.message) } }

const P = `${LANTERN_DIR}/lib/`
const src = fs.readFileSync(P + 'index.js', 'utf8')

console.log('\n=== G1 断连判定只能看 res（req.destroyed 读完 body 恒为 true）===')
t('G1a 不再用 req.destroyed 做断连判定', () => {
  assert.equal(src.includes('if (req.destroyed || res.destroyed) abort.abort()'), false,
    '仍在用 req.destroyed 判断连 —— 会让每个请求开局就 abort')
})
t('G1b 三处都改成 res.destroyed', () => {
  assert.equal((src.match(/if \(res\.destroyed\) abort\.abort\(\)/g) ?? []).length, 3)
})
t('G1c 注释说明原因', () => {
  assert.match(src, /req\.destroyed.*body 读完的那一刻就是 true/)
})

console.log('\n=== G2 空产出必须当失败，不能报成功 ===')
t('G2a isSubstantiveChunk 的 finish 不算产出', () => {
  const m = /function isSubstantiveChunk\(chunk\) \{[\s\S]*?\n\}/.exec(src)
  assert.ok(m, '找不到 isSubstantiveChunk')
  const body = m[0]
  assert.match(body, /case 'finish':[\s\S]*?return false/, 'finish 分支必须 return false')
  assert.equal(/case 'finish':\n[\s\S]*?return chunk\.reason\?\.kind !== 'error'/.test(body), false)
})
  t('G2b 流式路径有 empty_completion 判定', () => {
    assert.match(src, /resumeText\.length === 0[\s\S]{0,800}empty_completion/)
})
t('G2c 非流式路径有 isEmpty 判定', () => {
  assert.match(src, /aggregator\.isEmpty\(\)[\s\S]{0,200}empty_completion/)
})
t('G2d empty_completion 可重试', () => {
  assert.match(src, /code === 'empty_completion'\) return true/)
})

console.log('\n=== G3 三个聚合器都要有 isEmpty ===')
for (const [file, cls] of [['protocol.js', 'OpenAiAggregator'], ['anthropic.js', 'AnthropicAggregator'], ['responses.js', 'ResponsesAggregator']]) {
  t('G3 ' + cls + ' 有 isEmpty()', () => {
    const s = fs.readFileSync(P + file, 'utf8')
    assert.ok(s.includes('isEmpty() {'), file + ' 缺 isEmpty')
  })
}

console.log('\n=== G4 isEmpty 行为正确（真跑）===')
const proto = await import('file:///' + P.replace(/\\/g, '/') + 'protocol.js')
t('G4a 空聚合器 isEmpty=true', () => {
  const a = new proto.OpenAiAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'finish', reason: { kind: 'stop' } })
  assert.equal(a.isEmpty(), true)
})
t('G4b 有文本 isEmpty=false', () => {
  const a = new proto.OpenAiAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'text-delta', text: '你好' })
  assert.equal(a.isEmpty(), false)
})
t('G4c 只有推理也算有产出', () => {
  const a = new proto.OpenAiAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'reasoning-delta', text: '想一下' })
  assert.equal(a.isEmpty(), false)
})
t('G4d 只有工具调用也算有产出', () => {
  const a = new proto.OpenAiAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{}' })
  assert.equal(a.isEmpty(), false)
})

const anth = await import('file:///' + P.replace(/\\/g, '/') + 'anthropic.js')
t('G4e Anthropic 空聚合器 isEmpty=true', () => {
  const a = new anth.AnthropicAggregator({ id: 'x', model: 'm' })
  assert.equal(a.isEmpty(), true)
})
t('G4f Anthropic 有文本 isEmpty=false', () => {
  const a = new anth.AnthropicAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'text-delta', text: 'hi' })
  assert.equal(a.isEmpty(), false)
})

const resp = await import('file:///' + P.replace(/\\/g, '/') + 'responses.js')
t('G4g Responses 空聚合器 isEmpty=true', () => {
  const a = new resp.ResponsesAggregator({ id: 'x', model: 'm' })
  assert.equal(a.isEmpty(), true)
})
t('G4h Responses 有文本 isEmpty=false', () => {
  const a = new resp.ResponsesAggregator({ id: 'x', model: 'm' })
  a.push({ type: 'text-delta', text: 'hi' })
  assert.equal(a.isEmpty(), false)
})

console.log('\n=== 汇总: ' + pass + ' passed / ' + fail + ' failed ===')
if (fail > 0) process.exit(1)
