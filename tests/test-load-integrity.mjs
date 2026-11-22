// 模块加载护栏：真的 import 一次 lib/index.js。
//
// 这是本轮最痛的教训：`node --check` 只查语法，**查不出 TDZ**。
// 我把 `LIMIT_SPEC` 写在 use 之后，check 全绿，但模块顶层
// `withDefaults({})` → `normalizeLimits` 读它 → ReferenceError →
// 整个插件加载失败 → 3080 不监听 → 面板「异常：LIMIT_SPEC is not defined」。
//
// 所以这条必须是回归套件的一部分。做法：临时在插件目录放 @deepseek-ai/* stub，
// import 成功后再删掉。stub 只补「导出名」，不实现行为 —— 够加载即可。
import { LANTERN_DIR } from './paths.mjs'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PLUGIN = `${LANTERN_DIR}`
const NM = PLUGIN + '/node_modules'

const STUBS = {
  '@deepseek-ai/cordis': 'export default { Service: class {} }\nexport class Service {}\nexport const Context = class {}\n',
  '@deepseek-ai/dsh-llm': [
    "export const PLUGIN_ID = 'stub'",
    'export function createUserMessage(o) { return { role: \'user\', ...o } }',
    'export function createAssistantMessage(o) { return { role: \'assistant\', ...o } }',
    'export function createSystemMessage(t, p) { return { role: \'system\', content: t, provider: p } }',
    'export function createToolResultMessage(o) { return { role: \'tool\', ...o } }',
    'export const ReasoningEffort = {}',
    'export default {}',
  ].join('\n'),
  '@deepseek-ai/dsh-client-ui-slots': 'export default {}\nexport const Slot = {}\n',
  '@deepseek-ai/dsh-client-connection': 'export default {}\nexport const Connection = {}\n',
}

const created = []
let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  实际: ' + JSON.stringify(detail))) }
}

console.log('=== 真正的模块加载（能抓 TDZ）===')
try {
  for (const [name, body] of Object.entries(STUBS)) {
    const dir = `${NM}/${name}`
    if (!existsSync(dir)) created.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/package.json`, JSON.stringify({
      name, version: '0.0.0-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' },
    }), 'utf8')
    writeFileSync(`${dir}/index.js`, body, 'utf8')
  }

  let mod
  let importError
  try {
    // 加时间戳绕开 ESM 模块缓存（同一进程里反复测时必要）
    mod = await import(pathToFileURL(PLUGIN + '/lib/index.js').href + '?t=' + Date.now())
  } catch (e) {
    importError = e
  }

  t('LOAD1 lib/index.js 能真正 import 成功（无 TDZ / 无缺失依赖）',
    importError === undefined,
    importError === undefined ? undefined : { name: importError?.name, message: importError?.message })
  if (importError !== undefined) {
    console.log('      错误栈首帧: ' + String(importError?.stack ?? '').split('\n').slice(1, 3).join(' | '))
  }

  if (mod !== undefined) {
    t('LOAD2 导出 apply（插件入口）', typeof mod.apply === 'function' || typeof mod.default?.apply === 'function')
    t('LOAD3 导出 name', typeof mod.name === 'string' || typeof mod.default?.name === 'string')
    // LIMIT_SPEC 这类模块级常量的 TDZ 就是在这里暴露的：
    // 只要 import 成功，说明所有模块顶层初始化都没炸。
    t('LOAD4 模块顶层初始化无异常（DEFAULT_CONFIG 已构建）',
      mod.default !== undefined || mod.ModelDirectory !== undefined)
  }
} finally {
  for (const d of created) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  // 逐层清空父目录：@deepseek-ai 变空也要删，否则 node_modules/@deepseek-ai
  // 会一直残留（实测跑完留下一个空壳，虽然不影响运行但会让人以为被污染）。
  try {
    const scope = NM + '/@deepseek-ai'
    if (existsSync(scope) && readdirSync(scope).length === 0) rmSync(scope, { recursive: true, force: true })
  } catch { /* ignore */ }
  try {
    if (existsSync(NM) && readdirSync(NM).length === 0) rmSync(NM, { recursive: true, force: true })
  } catch { /* ignore */ }
}

console.log('\n=== 同类风险扫描：const 在 use 之后定义 ===')
{
  const src = readFileSync(PLUGIN + '/lib/index.js', 'utf8')
  // 找出所有模块级 const NAME = ...，记录其声明位置
  const decls = new Map()
  const re = /^(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*=/gm
  let m
  while ((m = re.exec(src)) !== null) decls.set(m[1], m.index)

  t('SCAN1 LIMIT_SPEC 已定义', decls.has('LIMIT_SPEC'))
  // LIMIT_SPEC 必须出现在 normalizeLimits 之前
  const normAt = src.indexOf('function normalizeLimits')
  const specAt = decls.get('LIMIT_SPEC')
  t('SCAN2 LIMIT_SPEC 在 normalizeLimits 之前声明',
    specAt !== undefined && normAt > 0 && specAt < normAt,
    { specAt, normAt })
  // DEFAULTS 之类：withDefaults 调用点之前必须有定义
  const wdCall = src.indexOf('withDefaults({})')
  t('SCAN3 模块顶层 withDefaults({}) 调用点存在', wdCall > 0, wdCall)
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
