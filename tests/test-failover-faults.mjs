#!/usr/bin/env node
/**
 * test-failover-faults.mjs — 1.1.3 故障转移「离线故障注入」单元测试。
 *
 * 目的：补上一轮真实调用验证里因缺少故障注入手段而「未执行」的 5 项。
 * 做法沿用 test-resume-unit*.mjs 的模式：从 lib/index.js 源码按字符串切片
 * 提取函数体，用 new Function 重建，把全部自由变量用 mock 注入后**真的跑**；
 * 关键状态用断言钉死，而不是只看源码形状。
 *
 * 全程离线：只读 lib/*.js；llm.stream / backendHealth / 定时器 / 聚合器都是
 * 内存 mock；不 import index.js 本体（它依赖 asar 内的 dsh-llm）、不联网、
 * 不写用户数据目录。
 *
 * 覆盖：
 *   1) 流式完整成功 → deps.backendHealth.recordSuccess(plan)（breakStreak 复位）
 *   2) 非流式空闲超时：每收到一块就重新计时（armTimer 在 for-await 循环体内）
 *   3) committed 后断流、续写全失败 → 错误不被吞（state.failure 被设置）+
 *      三条协议判据只看 fo.failure !== undefined
 *   4) 整轮重试：一轮全挂 → 撤销冷却 → 再跑一轮；已吐字禁止重跑；
 *      attempts.length=0 / round=0 归零（流式 + 非流式都跑）
 *   5) 全冷却不再直接 503：orderByHealth 在 allCooling===true 时 return list
 *      （不是 return []），且仍调 triggerBackgroundSweep
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')
const index = readFileSync(join(LIB, 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 200))) }
}

/** 按「函数声明」把源码切成互不重叠的片段，避免断言误命中别处同名字符串。 */
const section = (src, start, end) => {
  const s = src.indexOf(start)
  if (s < 0) return ''
  const e = src.indexOf(end, s + start.length)
  return src.slice(s, e < 0 ? src.length : e)
}

const streamFn = section(index, 'async function* streamWithFailover(', 'async function collectWithFailover(')
const collectFn = section(index, 'async function collectWithFailover(', 'function summarizeCapabilities(')
const orderFn = section(index, 'function orderByHealth(', 'function triggerBackgroundSweep(')
const tuneFn = section(index, 'function resolveTune(', 'function tuneOf(')

// ── 注入依赖（两套执行器共用一份超集；多余的参数被 new Function 忽略，无害）──
// 定时器用「永不触发」的假实现：这样离线、确定、不占真实时间；
// 同时用 setCalls / clearCalls 计数，直接证明 armTimer() 是否每块重新计时。
const timerState = { setCalls: 0, clearCalls: 0, id: 0 }
const resetTimers = () => { timerState.setCalls = 0; timerState.clearCalls = 0; timerState.id = 0 }

const INJECT = {
  maskSecrets: (x) => x,
  resolveTune: (t) => ({ timeoutMs: Number.isFinite(t?.timeoutMs) && t.timeoutMs > 0 ? Math.round(t.timeoutMs) : 0, retries: 0 }),
  isSubstantiveChunk: (c) => c?.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0,
  isRetryableFailure: () => false, // 历史遗留判据，保留注入位（源码里仍定义）
  linkSignals: (outer) => ({ signal: outer ?? {}, abort() {}, dispose() {} }),
  PLUGIN_ID: 'dsh-lantern',
  createAssistantMessage: (input) => ({ role: 'assistant', content: input?.content ?? [], ...(input ?? {}) }),
  createUserMessage: (input) => ({ role: 'user', content: input?.content ?? [], ...(input ?? {}) }),
  stripUnsupportedOption: () => undefined,
  detectLeakedToolMarkup: () => undefined,
  REASONING_BUDGET_BOOST: 3,
  REASONING_BUDGET_CEILING: 32768,
  setTimeout: (fn, ms) => { timerState.setCalls++; return ++timerState.id },
  clearTimeout: (id) => { timerState.clearCalls++ },
}

function buildExecutor(fnSrc, fnName) {
  const keys = Object.keys(INJECT)
  const factory = new Function(...keys, fnSrc + '\nreturn ' + fnName)
  return factory(...keys.map((k) => INJECT[k]))
}

// ── mock 工具 ──
function partsToStream(parts) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) {
        if (p.throwOn) throw Object.assign(new Error(p.throwOn), p.extra ?? {})
        else if (p.finishError) yield { type: 'finish', reason: { kind: 'error', failure: { message: p.finishError, code: p.code ?? 'upstream_error', status: p.status } } }
        else yield p
      }
    },
  }
}
function makeSctx(streamFor) {
  const calls = []
  return {
    calls,
    llm: {
      stream(opts) {
        const i = calls.length
        calls.push({ provider: opts.provider, model: opts.model, messages: opts.messages })
        return streamFor(opts, i)
      },
    },
  }
}
function makeHealth() {
  const rec = { engaged: [], success: [], failure: [], streamBreak: [], clearCooldowns: [] }
  return {
    rec,
    recordEngaged(plan) { rec.engaged.push(plan) },
    recordSuccess(plan) { rec.success.push(plan) },
    recordFailure(plan, failure) { rec.failure.push({ plan, failure }); return 30000 },
    recordStreamBreak(plan, failure) { rec.streamBreak.push({ plan, failure }); return 30000 },
    clearCooldowns(plans) { rec.clearCooldowns.push(plans); return plans.length },
  }
}
const makeDeps = (health) => ({ log: () => {}, backendHealth: health })
function makeAggregator() {
  return {
    failure: undefined,
    chunks: [],
    push(c) { this.chunks.push(c) },
    isEmpty() { return !this.chunks.some((c) => c.type === 'text-delta') },
    isReasoningOnly() { return false },
    leakedToolMarkup() { return undefined },
  }
}
const mkBase = () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
const plan = (binding, provider, model) => ({ binding, provider, model })
async function drain(gen) {
  const chunks = []
  let thrown
  try { for await (const c of gen) chunks.push(c) } catch (e) { thrown = e }
  return { chunks, thrown }
}

try {
  check('前置：四个源码片段均成功提取（提取失败会让后面假绿）',
    streamFn.length > 0 && collectFn.length > 0 && orderFn.length > 0 && tuneFn.length > 0,
    { stream: streamFn.length, collect: collectFn.length, order: orderFn.length, tune: tuneFn.length })

  const streamWithFailover = buildExecutor(streamFn, 'streamWithFailover')
  const collectWithFailover = buildExecutor(collectFn, 'collectWithFailover')

  // ══════════════════ 项 1：流式完整成功 → recordSuccess(plan) ══════════════════
  // 用**真实** BackendHealth 类：先 seed 一个 breakStreak，完整成功若没调
  // recordSuccess，breakStreak 永远清不掉（recordEngaged 有意不清它）。
  console.log('\n【1】流式完整成功调用 recordSuccess，breakStreak 复位')
  {
    const { BackendHealth } = await import('../lib/backend-health.js')
    const p1 = plan('b1', 'p1', 'm1')
    const health = new BackendHealth(
      () => ({ limits: { backendHealth: { enabled: true, cooldownSec: 30 } } }),
      () => 1000,
    )
    health.recordStreamBreak(p1, { code: 'stream_broken' })
    const before = health.snapshot().find((r) => r.key === BackendHealth.keyOf(p1))
    // 给真实对象挂一个计数 spy，直接观察 recordSuccess 被调了几次、参数是谁
    const successPlans = []
    const orig = health.recordSuccess.bind(health)
    health.recordSuccess = (p) => { successPlans.push(p); return orig(p) }

    const sctx = makeSctx(() => partsToStream([
      { type: 'text-delta', text: '完整回答' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const fo = { attempts: [] }
    const r = await drain(streamWithFailover(sctx, makeDeps(health), [p1], mkBase(), fo, { timeoutMs: 0 }))
    const after = health.snapshot().find((r) => r.key === BackendHealth.keyOf(p1))

    check('I1 完整成功确实调用了 deps.backendHealth.recordSuccess(plan)',
      successPlans.length === 1 && successPlans[0] === p1, successPlans.map((p) => p?.binding))
    check('I1 因此 breakStreak 从 1 复位为 0（否则永不复位）',
      before?.breakStreak === 1 && after?.breakStreak === 0,
      { before: before?.breakStreak, after: after?.breakStreak })
    check('I1 成功落地：state.plan 为本档、无 failure、正文送达',
      r.thrown === undefined && fo.plan === p1 && fo.failure === undefined &&
      r.chunks.some((c) => c.type === 'text-delta' && c.text === '完整回答'),
      { thrown: r.thrown?.message, plan: fo.plan?.binding, failure: fo.failure })
  }

  // ══════════════════ 项 2：非流式空闲超时，每块重新计时 ══════════════════
  // 真的跑一次 collectWithFailover：注入「永不触发」的假定时器，喂 3 块。
  // 若 armTimer() 只在循环前调一次（旧的总超时写法），setTimeout 只会 1 次；
  // 每收到一块重新计时则应为 1 + 块数 次。
  console.log('\n【2】非流式空闲超时：每收到一块就重新计时')
  {
    resetTimers()
    const fed = [
      { type: 'text-delta', text: 'A' },
      { type: 'text-delta', text: 'B' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const p1 = plan('b1', 'p1', 'm1')
    const sctx = makeSctx(() => partsToStream(fed))
    const health = makeHealth()
    const fo = { attempts: [] }
    const agg = await collectWithFailover(sctx, makeDeps(health), [p1], mkBase(), fo, () => makeAggregator(), { timeoutMs: 9999 })

    check('I2 真的跑通 collectWithFailover（返回聚合器、无 failure）',
      agg !== undefined && fo.failure === undefined, { failure: fo.failure })
    check('I2 每收到一块重新计时：setTimeout 次数 = 块数 + 1',
      timerState.setCalls === fed.length + 1,
      { setCalls: timerState.setCalls, expected: fed.length + 1 })
    check('I2 每次重新计时前先 clearTimeout 旧定时器',
      timerState.clearCalls >= fed.length + 1, { clearCalls: timerState.clearCalls })
    check('I2 无超时打断 → 成功时 recordSuccess 被调用',
      health.rec.success.length === 1, health.rec.success.map((p) => p?.binding))
    // 源码形状佐证
    check('I2 源码形状：aggregator.push(chunk) 之后的循环体内有 armTimer()',
      /aggregator\.push\(chunk\)[\s\S]{0,600}?armTimer\(\)/.test(collectFn))
    check('I2 源码形状：armTimer() 至少出现 2 次（循环外 + 循环内）',
      (collectFn.match(/armTimer\(\)/g) ?? []).length >= 2)
  }

  // ══════════════════ 项 3：committed 后断流、续写全失败 → 错误不被吞 ══════════════════
  // 场景 B（与源码 6245 注释逐字对应）：只有首档 commit 后断流，续写请求
  // 在提交前就失败 → 不抛异常、正常收尾；state.plan 仍是第一个提交档（有值），
  // state.failure 也被设置。旧判据 fo.plan === undefined 会把它吞成「200 + 半截回答」。
  console.log('\n【3】committed 后断流且续写全失败：错误不被吞')
  let run3B
  {
    const plans = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2'), plan('b3', 'p3', 'm3')]
    const sctx = makeSctx((opts) => opts.provider === 'p1'
      ? partsToStream([
          { type: 'text-delta', text: '半截' },
          { throwOn: 'drop1', extra: { code: 'stream_broken', status: 502 } },
        ])
      : partsToStream([{ throwOn: 'drop-' + opts.provider, extra: { code: 'upstream_error', status: 502 } }]))
    const health = makeHealth()
    const fo = { attempts: [] }
    const r = await drain(streamWithFailover(sctx, makeDeps(health), plans, mkBase(), fo, { timeoutMs: 0 }))
    run3B = { plans, sctx, health, fo, r }

    check('I3 续写全失败时正常收尾（不再抛异常）', r.thrown === undefined, r.thrown?.message)
    check('I3 错误不被吞：state.failure 已设置', fo.failure !== undefined, fo.failure)
    check('I3 state.plan 仍是第一个提交档 b1（旧判据 fo.plan===undefined 会漏报）',
      fo.plan?.binding === 'b1', fo.plan?.binding)
    check('I3 发生过 1 次断点续写，三档各尝试一次',
      fo.resumed === 1 && fo.attempts.length === 3,
      { resumed: fo.resumed, attempts: fo.attempts.length })
    check('I3 客户端仍拿到已吐出的半截正文',
      r.chunks.some((c) => c.type === 'text-delta' && c.text === '半截'), r.chunks)

    // 三条协议判据（chat / anthropic / responses 流式通道）源码形状
    const failChecks = (index.match(/if \(fo\.failure !== undefined\)/g) ?? []).length
    check('I3 三条流式协议判据都用 fo.failure !== undefined', failChecks === 3, failChecks)
    check('I3 协议判据不再要求 fo.plan === undefined 才报错',
      !/if \([^)]*fo\.plan === undefined/.test(index))
  }
  // 场景 A（补强）：三档都 commit 后断流 → 无处续写，抛 lanternCommittedFailure，
  // 且 fo.failure 在 throw 之前就被写入（同样不会被吞）。
  {
    const plans = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2'), plan('b3', 'p3', 'm3')]
    const sctx = makeSctx((opts) => partsToStream([
      { type: 'text-delta', text: 'X' + opts.provider },
      { throwOn: 'break-' + opts.provider, extra: { code: 'stream_broken', status: 502 } },
    ]))
    const health = makeHealth()
    const fo = { attempts: [] }
    const r = await drain(streamWithFailover(sctx, makeDeps(health), plans, mkBase(), fo, { timeoutMs: 0 }))
    check('I3 全档 commit+断流：抛 lanternCommittedFailure 且 fo.failure 已落',
      r.thrown instanceof Error && r.thrown.lanternCommittedFailure === true && fo.failure !== undefined,
      { threw: r.thrown?.message, flag: r.thrown?.lanternCommittedFailure, failure: fo.failure })
    check('I3 全档 commit+断流：续写用尽 2 次（MAX_RESUMES）', fo.resumed === 2, fo.resumed)
  }

  // ══════════════════ 项 4：整轮重试 ══════════════════
  console.log('\n【4】整轮重试：撤销冷却 → 再跑一轮；归零；已吐字禁止重跑')
  // 4A：一轮全挂 → clearCooldowns → 第二轮成功
  {
    const plans = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2')]
    const sctx = makeSctx((opts, i) => i < 2
      ? partsToStream([{ throwOn: 'fail-r1-' + opts.provider, extra: { code: 'upstream_error', status: 502 } }])
      : partsToStream([{ type: 'text-delta', text: 'OK' }, { type: 'finish', reason: { kind: 'stop' } }]))
    const health = makeHealth()
    const fo = { attempts: [] }
    await drain(streamWithFailover(sctx, makeDeps(health), plans, mkBase(), fo, { timeoutMs: 0 }))

    check('I4 一轮全挂 → clearCooldowns 调用 1 次',
      health.rec.clearCooldowns.length === 1, health.rec.clearCooldowns.length)
    check('I4 clearCooldowns 收到整条链 plans',
      health.rec.clearCooldowns[0] === plans, health.rec.clearCooldowns[0]?.map((p) => p?.binding))
    check('I4 index 走完两轮：stream 共 3 次（首轮 2 + 第二轮成功 1）',
      sctx.calls.length === 3, sctx.calls.length)
    check('I4 attempts.length=0 归零：最终只剩第二轮的 1 条（不是 3 条）',
      fo.attempts.length === 1, fo.attempts.length)
    check('I4 round=0 归零：第二轮 attempt.round === 1（不是 3）且 retry=false',
      fo.attempts[0]?.round === 1 && fo.attempts[0]?.retry === false,
      { round: fo.attempts[0]?.round, retry: fo.attempts[0]?.retry })
    check('I4 第二轮成功：fo.failure 未设置、fo.plan=b1',
      fo.failure === undefined && fo.plan === plans[0], { failure: fo.failure, plan: fo.plan?.binding })
    check('I4 成功时 recordSuccess 被调用',
      health.rec.success.length >= 1, health.rec.success.length)
  }
  // 4B：两轮都全挂 → 不再有第三轮，且状态仍归零
  {
    const plans = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2')]
    const sctx = makeSctx((opts) => partsToStream([
      { throwOn: 'always-' + opts.provider, extra: { code: 'upstream_error', status: 502 } },
    ]))
    const health = makeHealth()
    const fo = { attempts: [] }
    await drain(streamWithFailover(sctx, makeDeps(health), plans, mkBase(), fo, { timeoutMs: 0 }))

    check('I4 两轮全挂后 clearCooldowns 仍只 1 次（fullRoundRetried 防第三轮）',
      health.rec.clearCooldowns.length === 1, health.rec.clearCooldowns.length)
    check('I4 两轮共 stream 4 次', sctx.calls.length === 4, sctx.calls.length)
    check('I4 attempts.length 归零：最终 2 条（不是 4 条）',
      fo.attempts.length === 2, fo.attempts.length)
    check('I4 round 归零：两轮 attempt.round = [1,2]（不是 [3,4]）',
      fo.attempts.map((a) => a.round).join(',') === '1,2', fo.attempts.map((a) => a.round))
    check('I4 两轮全挂 → fo.failure 已设置（如实报全部失败）',
      fo.failure !== undefined, fo.failure)
  }
  // 4C：已吐字 → 禁止整轮重跑（复用项 3 场景 B 的那次真实运行）
  {
    const { health, sctx, fo } = run3B
    check('I4 已吐字时禁止整轮重跑：clearCooldowns 0 次',
      health.rec.clearCooldowns.length === 0, health.rec.clearCooldowns.length)
    check('I4 已吐字时不跑第二轮：stream 仅 3 次（无 4 次重跑）',
      sctx.calls.length === 3, sctx.calls.length)
    check('I4 已吐字时 attempts 未被归零（保留 3 条）',
      fo.attempts.length === 3, fo.attempts.length)
  }
  // 4D：非流式同样整轮重试（真的跑 collectWithFailover）
  {
    resetTimers()
    const plans = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2')]
    const sctx = makeSctx((opts, i) => i < 2
      ? partsToStream([{ throwOn: 'collect-fail-' + opts.provider, extra: { code: 'upstream_error', status: 502 } }])
      : partsToStream([{ type: 'text-delta', text: 'COK' }, { type: 'finish', reason: { kind: 'stop' } }]))
    const health = makeHealth()
    const fo = { attempts: [] }
    const agg = await collectWithFailover(sctx, makeDeps(health), plans, mkBase(), fo, () => makeAggregator(), { timeoutMs: 0 })

    check('I4 非流式也整轮重试：clearCooldowns 1 次',
      health.rec.clearCooldowns.length === 1, health.rec.clearCooldowns.length)
    check('I4 非流式 stream 共 3 次（两轮）', sctx.calls.length === 3, sctx.calls.length)
    check('I4 非流式 attempts.length 归零 → 1 条', fo.attempts.length === 1, fo.attempts.length)
    check('I4 非流式 round 归零 → round 1', fo.attempts[0]?.round === 1, fo.attempts[0]?.round)
    check('I4 非流式成功返回聚合器且 fo.failure 未设置',
      agg !== undefined && fo.failure === undefined, { failure: fo.failure })
    check('I4 非流式成功时 recordSuccess 被调用',
      health.rec.success.length >= 1, health.rec.success.length)
  }
  // 源码形状佐证：归零语句确实在（不引用已删除的 budget/canRetry/anyTimedOut）
  {
    check('I4 源码形状：stream 重试块含 attempts.length = 0 与 round = 0',
      /attempts\.length = 0/.test(streamFn) && /\bround = 0\b/.test(streamFn))
    check('I4 源码形状：collect 重试块含 attempts.length = 0 与 round = 0',
      /attempts\.length = 0/.test(collectFn) && /\bround = 0\b/.test(collectFn))
  }

  // ══════════════════ 项 5：全冷却不再直接 503 ══════════════════
  // 真的调 orderByHealth：注入一个返回 {allCooling:true} 的 backendHealth.order，
  // 以及记录调用的 triggerBackgroundSweep。断言返回的是**原链 list**（不是 []），
  // 且仍触发后台自检。
  console.log('\n【5】全冷却不再直接 503：orderByHealth 按原序放行')
  {
    const sweepCalls = []
    const triggerBackgroundSweep = (deps, plans) => { sweepCalls.push({ deps, plans }) }
    const orderByHealth = new Function('triggerBackgroundSweep', orderFn + '\nreturn orderByHealth')(triggerBackgroundSweep)
    const list = [plan('b1', 'p1', 'm1'), plan('b2', 'p2', 'm2'), plan('b3', 'p3', 'm3')]
    let orderCalled = 0
    const deps = {
      log: () => {},
      backendHealth: {
        order: (l) => { orderCalled++; return { plans: [], cooling: l.length, dropped: l.length, allCooling: true } },
      },
    }
    const result = orderByHealth(deps, list)

    check('I5 全冷却时 return list（返回的就是原链对象，不是 []）',
      result === list && result.length === 3 && result[0] === list[0] && result[2] === list[2],
      { same: result === list, len: result?.length })
    check('I5 确实咨询了 backendHealth.order', orderCalled === 1, orderCalled)
    check('I5 仍调用 triggerBackgroundSweep(deps, list)',
      sweepCalls.length === 1 && sweepCalls[0].deps === deps && sweepCalls[0].plans === list,
      { calls: sweepCalls.length })
    // 对照组：非全冷却时按 order().plans 返回，证明「return list」不是无脑恒为
    const depsHealthy = {
      log: () => {},
      backendHealth: { order: (l) => ({ plans: [l[1]], cooling: 1, allCooling: false }) },
    }
    const rHealthy = orderByHealth(depsHealthy, list)
    check('I5 对照：非全冷却时按 order() 结果返回（不是恒 return list）',
      rHealthy.length === 1 && rHealthy[0] === list[1], rHealthy.map((p) => p?.binding))
    // 源码形状佐证
    const branch = /ordered\.allCooling === true\)[\s\S]{0,4000}?return list/.exec(orderFn)
    const body = branch === null ? '' : branch[0]
    check('I5 源码形状：allCooling 分支 return list 而非 return []',
      branch !== null && !/return\s*\[\]/.test(body))
    check('I5 源码形状：该分支仍 triggerBackgroundSweep(deps, list)',
      /triggerBackgroundSweep\(deps, list\)/.test(body))
  }

  // ══════════════════ 配套：resolveTune（取源码重建、注入默认值）══════════════════
  {
    const resolveTune = new Function('DEFAULT_BACKEND_TIMEOUT_MS', tuneFn + '\nreturn resolveTune')(30000)
    check('配套 resolveTune(undefined) → { timeoutMs: 30000, retries: 0 }',
      resolveTune(undefined).timeoutMs === 30000 && resolveTune(undefined).retries === 0)
    check('配套 resolveTune({timeoutMs:0}) → { timeoutMs: 0, retries: 0 }',
      resolveTune({ timeoutMs: 0 }).timeoutMs === 0 && resolveTune({ timeoutMs: 0 }).retries === 0)
    check('配套 resolveTune({timeoutMs:1234}) → { timeoutMs: 1234, retries: 0 }',
      resolveTune({ timeoutMs: 1234 }).timeoutMs === 1234 && resolveTune({ timeoutMs: 1234 }).retries === 0)
  }
} catch (e) {
  console.log('  FATAL ' + (e?.stack ?? e))
  fail += 1
}

console.log(`\n═══ ${pass} passed / ${fail} failed ═══`)
process.exitCode = fail > 0 ? 1 : 0
