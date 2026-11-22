// 守卫测试：Cordis 生命周期（监听器不泄漏）
//
// 背景：Cordis 的 `ctx.on()` 返回**取消订阅函数**。不调用它，
// 监听器会一直挂在 ctx 上，插件禁用/重载后旧实例的闭包无法回收。
// 重载 N 次累积 N 个监听器 —— 表现为「改了配置没生效」「日志重复打印」
// 这类查不出根因的怪现象。
//
// 本测试守：插件里每一处 `ctx.on(...)` 都必须要么保存返回值并清理，
// 要么用 `ctx.effect(() => ...)` 托管给框架。
//
// 同类插件 dsh-providers-hub 的写法（可对照）：
//   const stop = ctx.on('llm/adapters-updated', () => {...})
//   return () => { stop(); ... }
import { readFileSync, readdirSync } from 'node:fs'
import { LANTERN_LIB as LIB } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ Cordis 生命周期守卫（#240）════════')
console.log('')

const files = readdirSync(LIB).filter((f) => f.endsWith('.js'))

// ── 1. 全项目扫描：不允许裸 ctx.on / this.ctx.on ──
console.log('【1】ctx.on 订阅必须托管')
const naked = []
const managed = []
for (const f of files) {
  const lines = readFileSync(`${LIB}/${f}`, 'utf8').split('\n')
  lines.forEach((L, i) => {
    if (/^\s*(\/\/|\*)/.test(L)) return
    if (!/(?:this\.)?ctx\.on\(\s*['"`]/.test(L)) return
    const assigned = /=\s*(?:this\.)?ctx\.on\(/.test(L)
    // 往上 4 行内是否有 ctx.effect(() =>
    const above = lines.slice(Math.max(0, i - 4), i).join('\n')
    const inEffect = /ctx\.effect\(\s*\(\)\s*=>\s*$/.test(above) || /ctx\.effect\(\(\)\s*=>\s*\n?\s*(?:this\.)?ctx\.on/.test(above + '\n' + L)
    if (assigned) managed.push(`${f}:${i + 1} (保存返回值)`)
    else if (inEffect) managed.push(`${f}:${i + 1} (ctx.effect)`)
    else naked.push(`${f}:${i + 1}: ${L.trim().slice(0, 80)}`)
  })
}
for (const m of managed) console.log(`      ✓ ${m}`)
for (const n of naked) console.log(`      ⚠ ${n}`)
t('没有裸 ctx.on 调用', naked.length === 0, naked)
t('存在已托管的订阅', managed.length > 0, { managed })

// ── 2. directory.js 的 start/dispose 配对 ──
console.log('')
console.log('【2】directory.js 的订阅与清理配对')
{
  const d = readFileSync(`${LIB}/directory.js`, 'utf8')
  t('start() 保存取消订阅函数', /this\.stopAdaptersUpdated = this\.ctx\.on/.test(d))
  t('dispose() 调用取消订阅', /this\.stopAdaptersUpdated\?\.\(\)/.test(d))
  t('dispose() 清 interval', /clearInterval\(this\.timer\)/.test(d))
  t('dispose() 清 debounceTimer', /clearTimeout\(this\.debounceTimer\)/.test(d))
  // 取消订阅要在 try 里（失败不阻断后续清理）
  t('取消订阅包在 try 里', /try\s*\{\s*\n?\s*this\.stopAdaptersUpdated\?\.\(\)/.test(d))
}

// ── 3. index.js 的订阅托管 ──
console.log('')
console.log('【3】index.js 的订阅托管')
{
  const s = readFileSync(`${LIB}/index.js`, 'utf8')
  t('llm/adapters-updated 用 ctx.effect 托管', /ctx\.effect\(\(\)\s*=>\s*\n?\s*ctx\.on\('llm\/adapters-updated'/.test(s))
  // 不能有「只 ctx.on 不 effect」的旧写法
  t('没有旧的裸 ctx.on(llm/adapters-updated)', !/(?<!ctx\.effect\(\(\) =>\s*\n?\s*)ctx\.on\('llm\/adapters-updated', \(\) => capabilities\.invalidate\(\)\)\s*$/.test(s))
}

// ── 4. 所有定时器都有清理 ──
console.log('')
console.log('【4】定时器清理')
{
  const TIMER_OWNERS = [
    ['directory.js', /this\.timer = setInterval/, /clearInterval\(this\.timer\)/],
    ['directory.js', /this\.debounceTimer = setTimeout/, /clearTimeout\(this\.debounceTimer\)/],
    ['attachments.js', /this\.timer = setInterval/, /clearInterval\(this\.timer\)/],
  ]
  for (const [f, createRe, clearRe] of TIMER_OWNERS) {
    const s = readFileSync(`${LIB}/${f}`, 'utf8')
    const hasCreate = createRe.test(s)
    const hasClear = clearRe.test(s)
    t(`${f} 有创建也有清理`, hasCreate && hasClear, { hasCreate, hasClear })
  }

  // 流式心跳与总超时（index.js 里各有 3 处）
  const idx = readFileSync(`${LIB}/index.js`, 'utf8')
  const hbCreate = (idx.match(/const heartbeat = setInterval/g) ?? []).length
  const hbClear = (idx.match(/clearInterval\(heartbeat\)/g) ?? []).length
  t(`heartbeat 创建 ${hbCreate} 处 / 清理 ${hbClear} 处`, hbCreate === hbClear && hbCreate > 0)

  const ttCreate = (idx.match(/const totalTimer = setTimeout/g) ?? []).length
  const ttClear = (idx.match(/clearTimeout\(totalTimer\)/g) ?? []).length
  t(`totalTimer 创建 ${ttCreate} 处 / 清理 ${ttClear} 处`, ttCreate === ttClear && ttCreate > 0)

  // 都 unref 了（不阻止进程退出）
  const hbUnref = (idx.match(/heartbeat\.unref\?\.\(\)/g) ?? []).length
  t(`heartbeat 都 unref（${hbUnref}/${hbCreate}）`, hbUnref === hbCreate)
  const ttUnref = (idx.match(/totalTimer\.unref\?\.\(\)/g) ?? []).length
  t(`totalTimer 都 unref（${ttUnref}/${ttCreate}）`, ttUnref === ttCreate)
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0