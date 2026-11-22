// test-health-wiring.mjs — 检查 index.js 里的接线是否**结构正确**（不跑 HTTP）。
//
// 为什么需要这条：backend-health.js 自身的单测证明的是记忆算法的行为，
// 但「谁在什么时候记账 / 账记完之后转发用的是哪份 plans」是 index.js 的接线问题，
// 那是纯文本层面的东西，最容易在改动里悄悄退回去。这里用源码断言把它钉住。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}/lib/index.js`
const src = readFileSync(P, 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra))
  }
}
const count = (needle) => src.split(needle).length - 1

// 三个通道各自的链变量名可能随重构变化（plansWithEffort / plansSorted /
// plansReady / anthPlans / respPlans），所以统一用"任一名字"求和，
// 这样改名不会让测试假失败 —— 它要验的是"有 3 处"，不是"叫某个名字"。
const CHAIN_VARS = ['plansWithEffort', 'plansSorted', 'plansReady', 'anthPlans', 'anthReady', 'respPlans', 'respReady']
const sumOf = (tmpl) => CHAIN_VARS.reduce((n, v) => n + count(tmpl(v)), 0)

console.log('\n【W1 三个通道都做了「闸门后重排」】')
check('W1 链声明 3 处',
  sumOf((v) => `const ${v} = orderByHealth(deps, plans)`) === 3,
  'sum=' + sumOf((v) => `const ${v} = orderByHealth(deps, plans)`))

console.log('\n【W2 执行时用的是重排后的链】')
check('W2 流式 3 处用链变量',
  sumOf((v) => `streamWithFailover(sctx, deps, ${v},`) === 3,
  'sum=' + sumOf((v) => `streamWithFailover(sctx, deps, ${v},`))
check('W2c 非流式 3 处调 collectWithFailover',
  count('await collectWithFailover(') === 3,
  'calls=' + count('await collectWithFailover('))

console.log('\n【W3 初始 plan 指向真会走的那档】')
check('W3 fo 3 处用链变量[0]',
  sumOf((v) => `const fo = { plan: ${v}[0]`) === 3,
  'sum=' + sumOf((v) => `const fo = { plan: ${v}[0]`))
check('W3b fo2 3 处用链变量[0]',
  sumOf((v) => `const fo2 = { plan: ${v}[0]`) === 3,
  'sum=' + sumOf((v) => `const fo2 = { plan: ${v}[0]`))

console.log('\n【W4 三种记账时机各就各位】')
// 流式路径：出第一个字时 recordEngaged（1 处，在 streamWithFailover 内）
check('W4 出第一个字 → recordEngaged', count('deps.backendHealth?.recordEngaged(plan)') === 1,
  'n=' + count('deps.backendHealth?.recordEngaged(plan)'))
check('W4b 中途断流 → recordStreamBreak', count('recordStreamBreak(') >= 1)
check('W4c 完整写完 → recordSuccess', count('recordSuccess(') >= 2, 'n=' + count('recordSuccess('))
check('W4d 普通失败 → recordFailure', count('recordFailure(') >= 2, 'n=' + count('recordFailure('))

console.log('\n【W5 客户端取消不记在后端头上】')
check('W5 三处都判了 abortByClient', count('abortByClient') >= 3, 'n=' + count('abortByClient'))

console.log('\n【W6 重排在闸门之前也做了一次（空链判断要用它）】')
check('W6 allPlans = orderByHealth(deps, rawPlans) 三处',
  count('orderByHealth(deps, rawPlans)') === 3, 'n=' + count('orderByHealth(deps, rawPlans)'))

console.log('\n【W7 响应头按最终链披露】')
check('W7 闸门后补刷故障转移头 3 处',
  sumOf((v) => `applyFailoverHeaders(res, ${v}, skipped, deps.current())`) === 3,
  'sum=' + sumOf((v) => `applyFailoverHeaders(res, ${v}, skipped, deps.current())`))

console.log('\n【W8 逐档注解（#121 档位 / #150 输出上限）】')
check('W8a annotatePlanEfforts 存在且有调用',
  count('async function annotatePlanEfforts') === 1 && count('await annotatePlanEfforts(') >= 1,
  { def: count('async function annotatePlanEfforts'), call: count('await annotatePlanEfforts(') })
check('W8b annotatePlanMaxOutput 存在且有调用',
  count('async function annotatePlanMaxOutput') === 1 && count('await annotatePlanMaxOutput(') >= 1,
  { def: count('async function annotatePlanMaxOutput'), call: count('await annotatePlanMaxOutput(') })
check('W8c 执行器按 plan.maxOutput 收窄 maxTokens（两处）',
  count('Math.min(baseOptions.maxTokens, plan.maxOutput)') === 2,
  'n=' + count('Math.min(baseOptions.maxTokens, plan.maxOutput)'))

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
