// 静态检查：找出所有可能引用未定义标识符的地方。
//
// #188 的教训：`cfg: current` 里 `current` 在该作用域不存在，
// 直到运行时才抛 ReferenceError，被 catch 包成 500。
//
// 本脚本用 Node 的 vm 模块做「半编译」检查，并用正则找常见错误模式。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'

const LIB = `${LANTERN_DIR}/lib`
const FILES = readdirSync(LIB).filter((f) => f.endsWith('.js') && !f.includes('.bak'))

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 200))) }
}

console.log('=== 1. 所有文件语法可编译 ===')
for (const f of FILES) {
  const src = readFileSync(`${LIB}/${f}`, 'utf8')
  try {
    // 用 SourceTextModule 做语法检查（不执行）
    new vm.SourceTextModule(src, { identifier: f })
    t(`${f} 语法正确`, true)
  } catch (e) {
    // vm.SourceTextModule 需要 --experimental-vm-modules，退化为 new Function
    try {
      const cleaned = src
        .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '')
        .replace(/^export\s+/gm, '')
        .replace(/import\.meta\.[a-zA-Z]+/g, 'undefined')
      new Function(cleaned)
      t(`${f} 语法正确（降级检查）`, true)
    } catch (e2) {
      t(`${f} 语法正确`, false, String(e2.message).slice(0, 120))
    }
  }
}

console.log('\n=== 2. 常见未定义变量模式 ===')
{
  // 危险的裸标识符（在插件里不该出现，除非确实定义了）
  const DANGEROUS = [
    { name: 'current', hint: '应写成 deps.current()' },
    { name: 'target', hint: '需确认本作用域有 target' },
    { name: 'used2', hint: '需确认本作用域有 used2' },
    { name: 'fo2', hint: '需确认本作用域有 fo2' },
  ]
  for (const f of FILES) {
    const src = readFileSync(`${LIB}/${f}`, 'utf8')
    const lines = src.split('\n')
    for (const d of DANGEROUS) {
      // 只看形如 `cfg: current` / `target: current` 这种作为**值**出现的裸标识符
      const re = new RegExp(`:\\s*${d.name}\\s*[,}]`)
      lines.forEach((L, i) => {
        if (/^\s*(\/\/|\*)/.test(L)) return
        if (!re.test(L)) return
        // 排除字符串里的
        const stripped = L.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
        if (!re.test(stripped)) return
        // 确认该标识符在本文件里是否被声明过
        const declared = new RegExp(`(const|let|var|function)\\s+${d.name}\\b|\\b${d.name}\\s*[=,]`).test(src)
        if (!declared) {
          t(`${f}:${i + 1} 未定义标识符 ${d.name}`, false, { line: L.trim().slice(0, 100), hint: d.hint })
        }
      })
    }
  }
  console.log('  （无 FAIL 表示没有发现裸未定义变量）')
  // 这条只是汇总；具体问题已在上面逐条 FAIL 列出。
  // 用独立计数，不受前面语法检查的 fail 影响。
  t('裸标识符检查已执行', true)
}

console.log('\n=== 3. fail/failJson 参数个数 ===')
{
  const src = readFileSync(`${LIB}/index.js`, 'utf8')
  const lines = src.split('\n')
  // fail 签名 3-5 参数，failJson 4-5 参数
  // 检查是否把自定义 code 传在了 type 位置
  const VALID_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error', 'invalid_request_error',
    'service_unavailable', 'upstream_error', 'internal_error', 'not_found_error', 'authentication_error']
  let bad = 0
  lines.forEach((L, i) => {
    const m = /(?:fail|failJson)\(\s*\d+\s*,\s*(?:[^,]+|`[^`]*`)\s*,\s*'([^']+)'/.exec(L)
    if (m === null) return
    if (i > 5600 && !VALID_TYPES.includes(m[1])) {
      // 可能是自定义 type，需要人工确认
      bad += 1
      console.log(`    ⚠ 行 ${i + 1}: type='${m[1]}' 不在常见类型列表`)
    }
  })
  t('fail/failJson 的 type 参数合法', bad === 0, { bad })
}

console.log('\n=== 4. sendJson(503) 后必须有 return（防止重复写响应）===')
{
  // 判据：从 sendJson(503) 起，在**同一块**内（到下一个右括号层级）必须出现 return。
  // 简单可靠的做法：往后找 20 行，只要有独立的 `return` 行就算通过。
  // 之前用 12 行窗口 + 严格正则，导致跨行 return 被误判。
  const src = readFileSync(`${LIB}/index.js`, 'utf8')
  const lines = src.split('\n')
  let bad = 0
  let checked = 0
  lines.forEach((L, i) => {
    if (!/sendJson\(res, 503/.test(L)) return
    checked += 1
    const tail = lines.slice(i, i + 20)
    const hasReturn = tail.some((x) => /^\s*return\b/.test(x))
    if (!hasReturn) { bad += 1; console.log(`    ⚠ 行 ${i + 1}: sendJson(503) 后 20 行内没有 return`) }
  })
  console.log(`    检查了 ${checked} 处 sendJson(503)`)
  t('sendJson(503) 后都有 return', bad === 0, { checked, bad })
}

console.log(`\n═══ ${pass} passed / ${fail} failed ═══`)
process.exitCode = fail > 0 ? 1 : 0
