// #229：模块完整性守卫 —— 防止"删死代码时误删入口/声明"。
//
// ## 为什么需要这个测试
//
// #226 按行号区间删掉两个死组件（1802 行），结果把紧邻区间末尾的
// `var inject = ['slots', 'connection']` 一起切掉了。
// 后果不是"某功能不可用"，而是**整个插件加载失败**：
//   "本页面的插件未能完成同步；服务端的启用状态保持不变"
//   "dsh-lantern: ReferenceError: inject is not defined"
//
// 而当时 853 项回归**全绿** —— 因为那些测试测的是服务端逻辑，
// 从来不检查 client.js 的模块出口。这是覆盖盲区。
//
// 本测试专门守住"插件能被平台正确加载"这一层：
//   · client.js 必须导出 { apply, inject, name }
//   · index.js 必须导出 apply
//   · rpc.js 必须导出 installManagementRpc（插件装配用）
//   · 各 lib 文件都必须能被 import 而不抛错
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LIB = `${LANTERN_DIR}/lib`

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))) }
}

console.log('════════ 模块完整性守卫（#229）════════')
console.log('')

const client = readFileSync(`${LIB}/client.js`, 'utf8')
const index = readFileSync(`${LIB}/index.js`, 'utf8')
const rpc = readFileSync(`${LIB}/rpc.js`, 'utf8')

// ── 1. client.js：平台加载所必需的三件套 ──
console.log('【1】client.js 模块出口')
t('声明 var inject = [...]', /var inject = \[\s*'slots'/.test(client), 'inject 缺失 → 插件加载报 ReferenceError')
t('声明 function apply(ctx)', /function apply\(ctx\)/.test(client))
t('导出 { apply, inject, name }', /module\.exports = \{\s*apply,\s*inject,\s*name:/.test(client), '导出不完整 → 平台无法装配')
// 顺序：inject 必须在 apply 之前被赋值（apply 里会读它？不读，但导出时两者都要已定义）
const iInject = client.indexOf('var inject')
const iApply = client.indexOf('function apply(ctx)')
const iExports = client.indexOf('module.exports =')
t('inject 声明在 apply 之前', iInject >= 0 && iInject < iApply, { iInject, iApply })
t('apply 在 module.exports 之前', iApply >= 0 && iApply < iExports, { iApply, iExports })

// ── 2. index.js：服务端入口 ──
console.log('')
console.log('【2】index.js 入口')
t('导出 function apply(ctx, config)', /export function apply\(ctx, config\)/.test(index))
t('引用 PLUGIN_ID', /PLUGIN_ID/.test(index))

// ── 3. rpc.js：管理面板 RPC ──
console.log('')
console.log('【3】rpc.js 出口')
t('导出 installManagementRpc', /export (async )?function installManagementRpc/.test(rpc))

// ── 4. 所有 lib 文件都能被 import（捕获语法/顶层求值错误）──
console.log('')
console.log('【4】各模块可 import（语法 + 顶层求值）')
const files = readdirSync(LIB).filter((f) => f.endsWith('.js') && !f.includes('.bak'))
let importFail = 0
for (const f of files) {
  try {
    await import(pathToFileURL(`${LIB}/${f}`).href)
  } catch (error) {
    // 依赖 DSH 运行时（如 @deepseek-ai/dsh-llm）的模块在纯 node 下会失败，
    // 那是环境问题不是代码问题 —— 只把"语法/引用错误"算失败。
    const msg = String(error?.message ?? '')
    // 两类**环境**问题不算代码错：
    //   · 依赖 DSH 运行时（@deepseek-ai/dsh-llm 等）→ 纯 node 下找不到包；
    //   · client.js 是浏览器端代码（`window.__ModuleLoader__` 是平台注入的）
    //     → 在 node 里没有 window，必然抛错。它由 #1 节的静态检查守。
    const isEnvIssue = /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)
      || /window is not defined|document is not defined/.test(msg)
    if (!isEnvIssue) {
      importFail += 1
      console.log(`    ✗ ${f}: ${msg.slice(0, 90)}`)
    }
  }
}
t('全部模块可 import（除依赖 DSH 运行时的）', importFail === 0, { importFail })

// ── 5. client.js 里不应残留已下线功能的 RPC 调用 ──
console.log('')
console.log('【5】无已下线功能的残留调用')
for (const dead of ['customTools/', 'providers/create', 'keys/rotate']) {
  t(`client.js 不调用 ${dead}`, !client.includes(dead))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0