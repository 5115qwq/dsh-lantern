import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs'
import path from 'node:path'

const P = `${LANTERN_DIR}/lib/index.js`
const SRC = fs.readFileSync(P, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : ' — ' + extra)) }
}

// 抽出 clampInt 真身
const m = /function clampInt\(value, min, max, fallback\) \{[\s\S]*?\n\}/.exec(SRC)
if (!m) { console.log('FAIL 抽不到 clampInt'); process.exit(1) }
const clampInt = new Function('return ' + m[0])()

console.log('── clampInt 本体 ──')
ok('正常值原样', clampInt(100, 1, 100000, 50) === 100)
ok('0 抬到下限', clampInt(0, 1, 100000, 100) === 1)
ok('负数抬到下限', clampInt(-5, 1, 64, 8) === 1)
ok('超大压到上限', clampInt(99999, 1, 64, 8) === 64)
ok("字符串数字也能收（'42' → 42）", clampInt('42', 1, 100, 7) === 42)
ok("空串走兜底（Number('') === 0 会被抬到 min，不是 fallback）", clampInt('', 1, 100, 7) === 1)
ok('NaN 走兜底', clampInt(NaN, 1, 100, 7) === 7)
ok('undefined 走兜底', clampInt(undefined, 1, 100, 7) === 7)
ok('null 走兜底（Number(null)=0 → 抬到 min）', clampInt(null, 1, 100, 7) === 1)
ok('小数四舍五入', clampInt(3.6, 1, 10, 5) === 4)
ok('min=0 允许 0（maxTokensCap 合法取值）', clampInt(0, 0, 1000000, 0) === 0)

console.log('\n── 接入点断言 ──')
ok('patchConfig 前定义了 clampedLimits', SRC.includes('const clampedLimits = {'))
ok('limits 合并里用了 clampedLimits', /limits: \{[\s\S]{0,600}?\.\.\.clampedLimits/.test(SRC))
// 第十二轮：三条区间都改成从 LIMIT_SPEC 派生（单一来源），
// 所以断言要验"派生关系"而不是硬编码数值 —— 否则每次调区间都要改测试。
ok('perKeyRpm 从 LIMIT_SPEC 派生',
  SRC.includes('perKeyRpm: clampInt(patchLimits.perKeyRpm, LIMIT_SPEC.perKeyRpm[0], LIMIT_SPEC.perKeyRpm[1], 100)'))
ok('maxTokensCap 从 LIMIT_SPEC 派生',
  SRC.includes('maxTokensCap: clampInt(patchLimits.maxTokensCap, LIMIT_SPEC.maxTokensCap[0], LIMIT_SPEC.maxTokensCap[1], 0)'))
ok('LIMIT_SPEC 里 maxTokensCap 的下界是 0（0 = 不封顶）',
  /maxTokensCap: \[0,/.test(SRC))
ok('LIMIT_SPEC 已定义（区间单一来源）', /const LIMIT_SPEC = Object\.freeze\(\{/.test(SRC))
ok('requestTimeoutMs 从 LIMIT_SPEC 派生',
  SRC.includes('requestTimeoutMs: clampInt(patchLimits.requestTimeoutMs, LIMIT_SPEC.requestTimeoutMs[0], LIMIT_SPEC.requestTimeoutMs[1], 600000)'))
ok('patchConfig 先落盘再改内存', /await writeJson\(PATHS\.config, nextConfig\)\s*\n\s*current = nextConfig/.test(SRC))

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAIL') + ': ' + pass + ' passed, ' + fail + ' failed')
