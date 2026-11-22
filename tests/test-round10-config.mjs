// 第十轮配置侧回归护栏（#115 并发丢更新 / #116 rotateGraceHours 永不过期）。
//
// 两条都属于"面板提示已保存、实际不是那个值"这一类最难排查的现象。
//
// 读源码时**不剥离注释**（原因见 test-round10-fixes.mjs 顶部说明）。
// 本文件内任何注释都不得出现"星号紧跟斜杠"的二字连排。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}/lib/`
const idx = readFileSync(P + 'index.js', 'utf8')
const rpc = readFileSync(P + 'rpc.js', 'utf8')

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

console.log('=== F115 并发 patchConfig 必须串行 ===')
{
  t('F115a 存在串行队列变量', idx.includes('let patchConfigChain = Promise.resolve()'))
  t('F115b patchConfig 排进队列',
    idx.includes('patchConfigChain.catch(() => {}).then(() => patchConfigOnce(patch))'))
  t('F115c 队列尾会推进', idx.includes('patchConfigChain = run.catch(() => {})'))
  t('F115d 实体已改名 patchConfigOnce', idx.includes('async function patchConfigOnce(patch)'))
  t('F115e .catch 兜住失败不卡死队列（先 catch 再推进）',
    idx.indexOf('patchConfigChain.catch(() => {})') < idx.indexOf('patchConfigChain = run.catch'))

  // 行为验证：照抄实现里的两行队列语义
  let chain = Promise.resolve()
  const order = []
  const patch = (name, delay, value, box) => {
    const run = chain.catch(() => {}).then(async () => {
      const snapshot = { ...box.current }
      await new Promise((r) => setTimeout(r, delay))
      box.current = { ...snapshot, ...value }
      order.push(name)
    })
    chain = run.catch(() => {})
    return run
  }
  const box = { current: { rpm: 11 } }
  await Promise.all([patch('A', 30, { rpm: 22 }, box), patch('B', 5, { tpm: 22222 }, box)])
  t('F115f 串行后两个字段都在（先完成者的改动没被回滚）',
    box.current.rpm === 22 && box.current.tpm === 22222, JSON.stringify(box.current))
  t('F115g 执行顺序是入队顺序', order.join(',') === 'A,B', order.join(','))

  // 反证：不串行时慢的那个用旧快照覆盖掉快的那个写的字段
  const order2 = []
  const patchUnsafe = (name, delay, value, box2) => new Promise((resolve) => {
    const snapshot = { ...box2.current }
    setTimeout(() => { box2.current = { ...snapshot, ...value }; order2.push(name); resolve() }, delay)
  })
  const box2 = { current: { rpm: 11 } }
  await Promise.all([patchUnsafe('A', 30, { rpm: 22 }, box2), patchUnsafe('B', 5, { tpm: 22222 }, box2)])
  t('F115h 反证：不串行时 B 写的 tpm 被 A 的旧快照覆盖（丢更新确实会发生）',
    box2.current.tpm === undefined, JSON.stringify(box2.current))
  t('F115i 反证：完成顺序是 B 先 A 后', order2.join(',') === 'B,A', order2.join(','))
}

console.log('\n=== F116 API Key 生命周期（#227 重写：生成即永久 + 明文可查看）===')
{
  // 旧语义（rotateGraceHours / expiresAt / 已过期）已全部下线。
  // 这些断言的作用是**防止它被误加回来**。
  t('F116a rpc.js 不再引用 rotateGraceHours', !/rotateGraceHours/.test(rpc), 'rpc 仍引用')
  t('F116b 默认配置里没有 rotateGraceHours: 24', !/rotateGraceHours: 24/.test(idx), '默认配置仍带它')
  t('F116c patchConfig 主动 delete 残留的 rotateGraceHours', /delete merged\.rotateGraceHours/.test(idx), '未找到 delete')
  t('F116d 不再有 Number(merged.rotateGraceHours) 的宽限期计算', !/Number\(merged\.rotateGraceHours\)/.test(idx), '仍在计算')

  // 新语义：Key 生成即永久（auth.js 里不写 expiresAt），且明文落盘可查看。
  const authSrc = readFileSync(P + 'auth.js', 'utf8')
  // 只看代码行（注释里会提到"原 expiresAt 逻辑已移除"，那不算逻辑残留）
  const authCode = authSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  t('F116e auth.js 代码里不再出现 expiresAt', !/expiresAt/.test(authCode), '仍有过期逻辑')
  t('F116f create() 保存明文', /^\s*plaintext,\s*$/m.test(authSrc), '未在 record 里保存 plaintext')
  t('F116g 有 reveal() 可取回明文', /reveal\(id\)\s*\{/.test(authSrc), '缺少 reveal()')
  t('F116h list() 只给 hasPlaintext 布尔、不给明文本身',
    /hasPlaintext:/.test(authSrc) && !/^\s*plaintext:\s*r\.plaintext/m.test(authSrc), 'list 可能泄露明文')
  t('F116i rotate() 已移除', !/async rotate\(/.test(authSrc), 'rotate 仍在')
  t('F116j verify() 不再判过期', !/expiresAt/.test(authSrc.split('verify(')[1] ?? ''), 'verify 仍判过期')

  // 面板：查看按钮走 keys/reveal，且不再有「重新生成」
  const clientSrc = readFileSync(P + 'client.js', 'utf8')
  t('F116k 面板调用 keys/reveal', /keys\/reveal/.test(clientSrc), '未接 reveal')
  t('F116l 面板不再调用 keys/rotate', !/keys\/rotate/.test(clientSrc), '仍在调 rotate')
  t('F116m 面板有「查看」按钮文案', /'查看'/.test(clientSrc), '缺少查看按钮')
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
