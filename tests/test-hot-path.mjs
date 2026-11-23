// #243：热路径性能守卫
//
// ## 背景
//
// 排查「Hub 加模型不刷新」时顺带发现的性能问题，都会在大目录下放大：
//
//   ① refresh() 并发竞态 —— 刷新期间到来的变化被丢弃
//      （不只是慢，是**丢事件**：新模型要等下一次事件或轮询才出现）
//   ② list() 每次调用都重新排序 —— 它在热路径上
//      （GET /v1/models 每个模型调一次；宽松路由回退也调）
//   ③ isPubliclyAllowed() 每次调用都新建数组并线性扫描
//      （黑名单 100 条 = 一次请求扫 300 次）
//   ④ 目录刷新对所有 provider 无上限并发 listModels
//      （provider 多时形成瞬时并发峰值，易触发上游限流）
//   ⑤ describe() 没有结果缓存 —— 每次重新组装 6+ 字段并 await 两次
//      （同一请求里同一模型会被组装多次）
//
// 本测试把这些约束固定下来。
import { readFileSync } from 'node:fs'
import { LANTERN_LIB as LIB } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ 热路径性能守卫（#243）════════')
console.log('')

const dir = readFileSync(`${LIB}/directory.js`, 'utf8')
const caps = readFileSync(`${LIB}/capabilities.js`, 'utf8')

// ── ① 刷新并发竞态 ──
console.log('【1】refresh() 并发语义')
t('有 refreshDirty 标记', /this\.refreshDirty/.test(dir))
t('刷新期间到来时置 dirty', /this\.refreshDirty = true/.test(dir))
t('结束后补刷一轮', /if \(this\.refreshDirty === true\)/.test(dir))
t('构造器初始化 refreshDirty', /this\.refreshDirty = false/.test(dir))

// ── ② list() 不再每次排序 ──
console.log('')
console.log('【2】list() 排序成本')
{
  const i = dir.indexOf('list() {')
  const body = dir.slice(i, i + 400)
  t('list() 不再调用 .sort(', !/\.sort\(/.test(body), body.slice(0, 120))
  t('list() 返回缓存副本', /\.\.\.\(this\.sorted \?\? \[\]\)/.test(body), body.slice(0, 120))
  t('#refreshInner 里算好排序', /this\.sorted = \[\.\.\.entries\]\.sort/.test(dir))
  t('构造器初始化 sorted', /this\.sorted = \[\]/.test(dir))
}

// ── ③ isPubliclyAllowed 用 Set ──
console.log('')
console.log('【3】isPubliclyAllowed 过滤器')
{
  const i = dir.indexOf('isPubliclyAllowed(')
  const body = dir.slice(i, i + 1200)
  t('用 Set 而非数组 includes', /new Set\(/.test(body), '仍在线性扫描')
  t('有 filterCache', /this\.filterCache/.test(body))
  t('按 filters 引用失效', /this\.filterCache\.src !== filters/.test(body))
  t('构造器初始化 filterCache', /this\.filterCache = undefined/.test(dir))
}

// ── ④ 目录刷新并发上限 ──
console.log('')
console.log('【4】目录刷新的上游并发')
t('有 mapSettledWithConcurrency 辅助函数', /async function mapSettledWithConcurrency/.test(dir))
t('目录刷新使用它', /mapSettledWithConcurrency\(\s*\n?\s*providers/.test(dir))
{
  // 只检查**实际代码行**，注释里提到 allSettled 是文档说明，不算
  const codeOnly = dir
    .split('\n')
    .filter((L) => !/^\s*(\/\/|\*|\/\*)/.test(L))
    .join('\n')
  t(
    '不再对全部 provider 直接 allSettled',
    !/Promise\.allSettled\(\s*\n?\s*providers\.map/.test(codeOnly),
    '目录刷新仍会形成无上限并发峰值',
  )
}

// ── ⑤ describe() 缓存 ──
console.log('')
console.log('【5】describe() 结果缓存')
t('构造器有 describeCache', /this\.describeCache = new Map\(\)/.test(caps))
t('describe 开头查缓存', /const cachedView = this\.describeCache\.get\(cacheKey\)/.test(caps))
t('describe 结尾写缓存', /this\.describeCache\.set\(cacheKey, result\)/.test(caps))
t('invalidate() 清空', /this\.describeCache\.clear\(\)/.test(caps))
t('cacheKey 含 generation', /const cacheKey = `\$\{provider\}\\u0000\$\{model\}\\u0000\$\{this\.generation\}`/.test(caps))

// ── 运行时：确认辅助函数语义正确 ──
console.log('')
console.log('【6】mapSettledWithConcurrency 行为')
{
  // 从模块里拿不到内部函数（未导出），这里做静态语义检查：
  // 必须同时产生 fulfilled 与 rejected，且顺序保持
  t('保留 fulfilled 形状', /status: 'fulfilled'/.test(dir))
  t('保留 rejected 形状', /status: 'rejected'/.test(dir))
  t('按 index 写回结果（保持顺序）', /results\[index\] =/.test(dir))
  t('单点失败不影响其它（catch 包住）', /catch \(reason\) \{\s*\n?\s*results\[index\] = \{ status: 'rejected'/.test(dir))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0