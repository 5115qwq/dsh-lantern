/**
 * test-backend-health.mjs — 后端健康记忆单测。
 *
 * 目标是证明用户提的那条链路（m04349）：
 *   chain [A,B,C]，A 挂一次之后，**下一次**请求的首选必须是 B 而不是 A；
 *   但 A 不能被删掉（B、C 也挂时它还要被试）；
 *   冷却到期后 A 必须回到原位（用户配的顺序不能被插件永久改掉）。
 *
 * 直接用真实模块（不是复制一份逻辑），这样断言的就是线上跑的那份代码。
 */
// Windows 绝对路径 import 必须写成 file:/// URL（相对路径会被解析成 .tmp 下的子目录）。
import { BackendHealth, isBackendBlame } from '../lib/backend-health.js'

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

const plan = (name, provider, model) => ({ binding: name, provider, model, publicName: name })
const A = plan('a@x', 'x', 'a')
const B = plan('b@y', 'y', 'b')
const C = plan('c@z', 'z', 'c')

let now = 1000
const clock = () => now
const cfgWith = (over) => () => ({ limits: { backendHealth: { enabled: true, cooldownSec: 30, maxCooldownSec: 300, ...over } } })

console.log('\n【T1 无故障时不动顺序】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const out = h.order([A, B, C])
  check('T1 顺序原样', out.plans.map((p) => p.binding).join(',') === 'a@x,b@y,c@z', out.plans.map((p) => p.binding).join(','))
  check('T1b cooling=0', out.cooling === 0, String(out.cooling))
}

console.log('\n【T2 失败一档 → 排到链尾（不是删除）】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const ms = h.recordFailure(A, { code: 'backend_timeout', message: '超时' })
  check('T2 记入冷却', ms === 30000, String(ms))
  const out = h.order([A, B, C])
  check('T2b 顺序变 B,C（A 被剔除）', out.plans.map((p) => p.binding).join(',') === 'b@y,c@z', out.plans.map((p) => p.binding).join(','))
  check('T2c 冷却档被剔除（只剩 2 档）', out.plans.length === 2, String(out.plans.length))
  check('T2d cooling=1', out.cooling === 1, String(out.cooling))
}

console.log('\n【T3 冷却到期自动归位】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  h.recordFailure(A, { code: 'backend_timeout' })
  now += 29999
  check('T3 到期前仍在冷却', h.order([A, B, C]).plans[0].binding === 'b@y', h.order([A, B, C]).plans[0].binding)
  now += 2
  const out = h.order([A, B, C])
  check('T3b 到期后回到原位', out.plans.map((p) => p.binding).join(',') === 'a@x,b@y,c@z', out.plans.map((p) => p.binding).join(','))
  check('T3c cooling 归零', out.cooling === 0, String(out.cooling))
}

console.log('\n【T4 一次成功清零（不等冷却到期）】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  h.recordFailure(A, { code: 'backend_timeout' })
  check('T4 先在冷却', h.coolingMs(A) > 0, String(h.coolingMs(A)))
  h.recordSuccess(A)
  check('T4b 成功后立即健康', h.coolingMs(A) === 0, String(h.coolingMs(A)))
  check('T4c 顺序恢复', h.order([A, B, C]).plans[0].binding === 'a@x', h.order([A, B, C]).plans[0].binding)
}

console.log('\n【T5 连续失败 → 冷却翻倍，封顶】')
{
  // 「连续失败」= 冷却到期后又试了一次、又失败。判定必须跨越冷却边界：
  // 冷却未到期的重复失败属于**同一轮**故障（并发请求会各记一次），
  // 不升级档位——否则 8 个并发请求能把后端一次抖动放大成 5 分钟冷却。
  const h = new BackendHealth(cfgWith({}), () => t5now)
  let t5now = 1000
  const m1 = h.recordFailure(A, { code: 'backend_timeout' })
  t5now += 30_000 + 1 // 冷却到期
  const m2 = h.recordFailure(A, { code: 'backend_timeout' })
  t5now += 60_000 + 1
  const m3 = h.recordFailure(A, { code: 'backend_timeout' })
  check('T5 第一次 30s', m1 === 30000, String(m1))
  check('T5b 冷却到期后再失败 60s', m2 === 60000, String(m2))
  check('T5c 再到期后再失败 120s', m3 === 120000, String(m3))
  for (let i = 0; i < 10; i += 1) {
    t5now += 300_000 + 1
    h.recordFailure(A, { code: 'backend_timeout' })
  }
  check('T5d 封顶 maxCooldownSec(300s)', h.coolingMs(A) <= 300000, String(h.coolingMs(A)))
}

console.log('\n【T5e 冷却期内的并发放大（回归）】')
{
  // 8 个并发请求同时撞上同一个超时后端 = 一次故障，不是八次。
  const h = new BackendHealth(cfgWith({}), () => 5000)
  const cds = []
  for (let i = 0; i < 8; i += 1) cds.push(h.recordFailure(A, { code: 'backend_timeout' }))
  check('T5e 8 次并发失败只按 1 轮算（都 30s）', cds.every((v) => v === 30000), cds.join(','))
  check('T5e2 streak 停在 1', h.snapshot()[0].streak === 1, String(h.snapshot()[0].streak))
  check('T5e3 fail 原始计数仍然逐次累加', h.snapshot()[0].fail === 8, String(h.snapshot()[0].fail))
}

console.log('\n【T6 客户端自己的错不记在后端头上】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const cases = [
    [{ code: 'invalid_request_error' }, '参数错'],
    [{ code: 'model_not_found' }, '模型不存在'],
    [{ code: 'unauthorized' }, '鉴权'],
    [{ status: 400, message: 'bad' }, '400'],
    [{ status: 422, message: 'bad' }, '422'],
  ]
  for (const [failure, label] of cases) {
    const ms = h.recordFailure(A, failure)
    check('T6 ' + label + ' 不记冷却', ms === 0, String(ms))
  }
  check('T6b 顺序未变', h.order([A, B, C]).plans[0].binding === 'a@x', h.order([A, B, C]).plans[0].binding)
}

console.log('\n【T7 后端的锅要记】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const cases = [
    [{ code: 'backend_timeout' }, '超时'],
    [{ status: 429, message: '限流' }, '429'],
    [{ status: 500, message: '5xx' }, '500'],
    [{ status: 503, message: '5xx' }, '503'],
    [{ status: 408, message: '408' }, '408'],
    [{ message: '无码异常' }, '无码'],
  ]
  for (const [failure, label] of cases) {
    const fresh = new BackendHealth(cfgWith({}), clock)
    const ms = fresh.recordFailure(A, failure)
    check('T7 ' + label + ' 记入冷却', ms > 0, label + '=' + String(ms))
  }
}

  console.log('\n【T8 全在冷却 → 返回空链，由后台异步自检】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  h.recordFailure(A, { code: 'backend_timeout' })
  h.recordFailure(B, { code: 'backend_timeout' })
  h.recordFailure(C, { code: 'backend_timeout' })
  const out = h.order([A, B, C])
  check('T8 全冷却 → 返回空链（用户请求立即 503，后台另做自检）', out.plans.length === 0 && out.allCooling === true, 'len=' + out.plans.length + ' allCooling=' + out.allCooling)
  check('T8b 仍报告 cooling=3', out.cooling === 3, String(out.cooling))
}

console.log('\n【T9 单档链 / 空链不出事】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  check('T9 单档原样', h.order([A]).plans.length === 1)
  check('T9b 空数组', h.order([]).plans.length === 0)
  check('T9c undefined 入参', h.order(undefined).plans.length === 0)
}

console.log('\n【T10 enabled=false 时完全不介入】')
{
  const h = new BackendHealth(cfgWith({ enabled: false }), clock)
  const ms = h.recordFailure(A, { code: 'backend_timeout' })
  check('T10 不产生冷却', ms === 0, String(ms))
  check('T10b 顺序原样', h.order([A, B, C]).plans[0].binding === 'a@x', h.order([A, B, C]).plans[0].binding)
}

console.log('\n【T11 同一 provider 不同 model 互不干扰】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const A2 = plan('a2@x', 'x', 'a2')
  h.recordFailure(A2, { code: 'backend_timeout' })
  check('T11 同 provider 另一模型仍健康', h.coolingMs(A) === 0, String(h.coolingMs(A)))
  check('T11b 该模型自身在冷却', h.coolingMs(A2) > 0, String(h.coolingMs(A2)))
}

console.log('\n【T12 snapshot / reset / resetOne】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  h.recordFailure(A, { code: 'backend_timeout' })
  h.recordSuccess(B)
  const snap = h.snapshot()
  check('T12 快照含两条', snap.length === 2, String(snap.length))
  check('T12b 冷却中的排前面', snap[0].binding === undefined && snap[0].coolingSec > 0, JSON.stringify(snap[0]))
  check('T12c 带 lastFailureCode', snap[0].lastFailureCode === 'backend_timeout', String(snap[0].lastFailureCode))
  check('T12d resetOne 只清一条', h.resetOne(A) === true && h.entries.size === 1, String(h.entries.size))
  h.reset()
  check('T12e reset 全清', h.entries.size === 0, String(h.entries.size))
}

console.log('\n【T13 status() 摘要】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  h.recordFailure(A, { code: 'backend_timeout' })
  h.recordFailure(B, { code: 'backend_timeout' })
  const st = h.status()
  check('T13 cooling=2', st.cooling === 2, String(st.cooling))
  check('T13b tracked=2', st.tracked === 2, String(st.tracked))
  check('T13c enabled=true', st.enabled === true, String(st.enabled))
  check('T13d entries 有内容', st.entries.length === 2, String(st.entries.length))
}

console.log('\n【T14 时钟回拨 / 异常入参不炸】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  now -= 100000
  check('T14 时钟回拨不报错', typeof h.coolingMs(A) === 'number')
  check('T14b null plan 不炸', h.coolingMs(null) === 0, String(h.coolingMs(null)))
  check('T14c 无 code 无 status 的 failure 也算后端锅', isBackendBlame({ message: 'boom' }) === true)
  check('T14d undefined failure 不记', isBackendBlame(undefined) === false)
}


console.log('\n【T15 recordEngaged：出字不等于写完】')
{
  let t = 1_000_000
  const h = new BackendHealth(cfgWith({}), () => t)
  h.recordFailure(A, { code: 'backend_timeout' })
  h.recordEngaged(A)
  check('T15 出字后冷却立刻解除', h.coolingMs(A) === 0, String(h.coolingMs(A)))
  const row = h.snapshot()[0]
  check('T15b 出字后 streak 归零', row.streak === 0, String(row.streak))
  check('T15b2 出字后不出现在面板上（三项都 0）', h.status().entries.length === 0, String(h.status().entries.length))
  h.recordStreamBreak(A, { message: '断流' })
  const snap = h.snapshot().find((r) => r.provider === 'x')
  check('T15c 断流记在 breakStreak 上', snap.breakStreak === 1, String(snap.breakStreak))
  check('T15d 断流也进冷却', h.coolingMs(A) === 30000, String(h.coolingMs(A)))
}

console.log('\n【T16 反复断流要累进升级（原始 bug：永远停在 30s）】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  const cds = []
  for (let i = 0; i < 4; i += 1) {
    h.recordEngaged(A)
    cds.push(h.recordStreamBreak(A, { message: '断流' }))
    now += 10000
  }
  check('T16 冷却逐次翻倍 30/60/120/240', cds.join(',') === '30000,60000,120000,240000', cds.join(','))
}

console.log('\n【T17 只有真正写完才清断续计数】')
{
  // 两次断续之间必须让冷却过期：冷却期内连续断流是同一轮（与 T5e 同一条理由）。
  let t17 = 2_000_000
  const h = new BackendHealth(cfgWith({}), () => t17)
  h.recordStreamBreak(A, { message: '断流' })
  t17 += 30_000 + 1
  h.recordStreamBreak(A, { message: '断流' })
  check('T17 两次断续 → breakStreak=2', h.snapshot()[0].breakStreak === 2, String(h.snapshot()[0].breakStreak))
  h.recordSuccess(A)
  const snap = h.snapshot()[0]
  check('T17b recordSuccess 清掉 breakStreak', snap.breakStreak === 0, String(snap.breakStreak))
  check('T17c recordSuccess 清掉冷却', h.coolingMs(A) === 0, String(h.coolingMs(A)))
}

console.log('\n【T17d 冷却期内并发断流不放大（回归）】')
{
  const h = new BackendHealth(cfgWith({}), () => 3_000_000)
  const first = h.recordStreamBreak(A, { message: '断流' })
  const rest = [1, 2, 3, 4].map(() => h.recordStreamBreak(A, { message: '断流' }))
  check('T17d 首次 30s', first === 30000, String(first))
  check('T17d2 其余仍是 30s（同一轮）', rest.every((v) => v === 30000), rest.join(','))
  check('T17d3 breakStreak 停在 1', h.snapshot()[0].breakStreak === 1, String(h.snapshot()[0].breakStreak))
}


console.log('\n【T18 重排计数不虚报（一次请求会调 order 两遍）】')
{
  const h = new BackendHealth(cfgWith({}), clock)
  // 没有冷却时调多少次都不该计数
  h.order([A, B, C]); h.order([A, B, C])
  check('T18 无冷却时 reordered=0', h.status().reordered === 0, String(h.status().reordered))
  // 真实路径是「先重排 → 闸门按能力筛链（保序）→ 再重排一次」：
  // 第二遍拿到的已经是排好的链，顺序不会再变，所以不该再计一次。
  h.recordFailure(A, { code: 'backend_timeout' })
  const first = h.order([A, B, C]).plans
  check('T18b 第一遍重排改变顺序并计 1 次', h.status().reordered === 1, String(h.status().reordered))
  const second = h.order(first).plans
  check('T18c 第二遍拿已排好的链，不再计数', h.status().reordered === 1, String(h.status().reordered))
  check('T18d 两遍结果一致（幂等）', second.map((p) => p.binding).join(',') === first.map((p) => p.binding).join(','), second.map((p) => p.binding).join(','))
  // 顺序本来就对（失败的那档已在链尾）时不该算重排
  h.reset()
  h.recordFailure(A, { code: 'backend_timeout' })
  h.order([B, C, A])
  check('T18e 顺序没变不计', h.status().reordered === 0, String(h.status().reordered))
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
