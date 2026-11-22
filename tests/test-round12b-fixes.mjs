// 第十二轮后半的护栏：
//   #136/#141 流式故障转移头必须在 flushHeaders 之前写
//   #137 abort 传导与并发槽不泄漏（在线行为，见 .failover-suite.mjs 第 6 组）
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const L = `${LANTERN_DIR}/lib/`
const idx = readFileSync(L + 'index.js', 'utf8')
const bh = readFileSync(L + 'backend-health.js', 'utf8')

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  实际: ' + JSON.stringify(detail))) }
}

console.log('=== #141 流式头必须在 flushHeaders 之前写 ===')
{
  // 只数**真正执行**的调用：先按行过滤掉注释行。
  // （否则注释里提到 res.flushHeaders?.() 也会被算进去 —— 本轮就踩了这个。）
  const lines = idx.split('\n')
  let offset = 0
  const flushPositions = []
  for (const line of lines) {
    const code = line.replace(/\/\/.*$/, '')
    if (/res\.flushHeaders\?\.\(\)/.test(code)) flushPositions.push(offset)
    offset += line.length + 1
  }
  t('141a 找到 3 处真实的 flushHeaders 调用', flushPositions.length === 3, flushPositions.length)

  // 每处之前 900 字符内必须有 fo0 与 applyServedHeaders
  let covered = 0
  for (const pos of flushPositions) {
    const win = idx.slice(Math.max(0, pos - 900), pos)
    if (win.includes('const fo0') && win.includes('applyServedHeaders(res, fo0')) covered += 1
  }
  t('141b 每处 flushHeaders 之前都写了故障转移头', covered === flushPositions.length,
    `${covered}/${flushPositions.length}`)
}

console.log('\n=== #136 三个通道各有流式循环 ===')
{
  const starts = []
  const re = /for await \(const chunk of streamWithFailover\(/g
  let m
  while ((m = re.exec(idx)) !== null) starts.push(m.index)
  t('136a 找到 3 处流式循环', starts.length === 3, starts.length)
}

console.log('\n=== #137 abort 传导（源码级）===')
{
  t('137a 断连信号挂在 res 上（不是 req）', /res\.on\('close', onClose\)/.test(idx))
  t('137b 有 res.destroyed / writableEnded 兜底',
    /res\.destroyed/.test(idx) || /res\.writableEnded/.test(idx))
  t('137c 客户端取消不记后端失败',
    /abortByClient/.test(idx) || /abortByClient/.test(bh))
  t('137d 循环内检查 abort.signal.aborted', /if \(abort\.signal\.aborted\) break/.test(idx))
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
