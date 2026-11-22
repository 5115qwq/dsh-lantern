import { LANTERN_DIR } from './paths.mjs'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

/**
 * 离线回归总运行器。
 *
 * 逐个执行 `tests/` 下的测试文件，解析它们输出的 PASS/FAIL 计数并汇总。
 *
 * 任一测试以非零退出码结束、或有断言失败时，本脚本以 1 退出，
 * 并在末尾打印**失败测试的输出片段** —— 否则 CI 上只能看到一行 `exit=1`，
 * 无从判断是断言失败还是模块加载崩溃。
 */
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => /^(smoke-|test-|simulate-|check-).*\.mjs$/.test(f))
  .sort()

const { execFileSync } = await import('node:child_process')
const NODE = process.execPath

let total = 0
let failed = 0
const bad = []
const rows = []

for (const f of files) {
  let out = ''
  let code = 0
  try {
    out = execFileSync(NODE, [f], {
      cwd: TEST_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
    code = e.status ?? 1
  }

  let p = 0
  let fl = 0
  let m
  if ((m = /ALL PASS:\s*(\d+)\s+passed[^\d]+(\d+)\s+failed/.exec(out))) { p = +m[1]; fl = +m[2] }
  else if ((m = /(\d+)\s*PASS[,\s/]+(\d+)\s*FAIL/.exec(out))) { p = +m[1]; fl = +m[2] }
  else if ((m = /(\d+)\s+passed[^\d]+(\d+)\s+failed/.exec(out))) { p = +m[1]; fl = +m[2] }
  else if (/ALL OK/.test(out)) { p = 1 }
  else { p = (out.match(/:\s*PASS/g) ?? []).length; fl = (out.match(/:\s*FAIL/g) ?? []).length }

  total += p
  failed += fl
  rows.push({ f, p, fl, code, out })
  if (code !== 0 || fl > 0) bad.push({ f, code, p, fl, out })
}

rows.forEach((r) => {
  console.log(String(r.p).padStart(3) + '  ' + (r.fl > 0 ? 'FAIL:' + r.fl : '    ') + '  ' + r.f)
})

console.log('')
console.log('==== ' + rows.length + ' 套 / ' + total + ' 项 / ' + failed + ' 失败 ====')

if (bad.length > 0) {
  console.log('')
  console.log('有问题的：')
  bad.forEach((b) => console.log('  ' + b.f + ' exit=' + b.code + ' p=' + b.p + ' f=' + b.fl))

  // 打印失败测试的输出片段 —— CI 上排障的关键信息
  for (const b of bad) {
    console.log('')
    console.log('──── ──── ' + b.f + ' ──── ────')
    const lines = String(b.out).split('\n').filter((l) => l.trim().length > 0)
    // 优先打印含 FAIL/Error 的行，其次打印尾部
    const important = lines.filter((l) => /FAIL|Error|error|✗|Cannot|undefined/.test(l))
    const picked = important.length > 0 ? important.slice(0, 12) : lines.slice(-12)
    for (const l of picked) console.log('  ' + l.trim().slice(0, 160))
  }
  process.exit(1)
}

console.log('全部通过')