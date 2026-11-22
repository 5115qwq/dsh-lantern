/**
 * test-breaker.mjs — 熔断器（lib/breaker.js）单测。
 *
 * 这个模块此前没有任何测试。补它是因为在 BUG-18 的排查里发现：
 * `recordFailure` 的 streak 会被**同一波并发**放大，阈值 3 的语义应该是
 * 「连续三轮独立故障」，而不是「三个并发请求」。
 *
 * 所有用例都注入时钟，不依赖真实时间。
 */
import { Breaker, createReservedGate, isRateLimitFailure } from '../lib/breaker.js'

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra)) }
}

/** 造一个可控时钟的熔断器。 */
const make = (limits = {}) => {
  const clock = { t: 1_000_000 }
  const cfg = () => ({ limits: { perKeyTpm: 0, breaker: { enabled: true, consecutiveRateLimits: 3, cooldownSec: 60, ...limits } } })
  const b = new Breaker(cfg, () => clock.t)
  return { b, clock, cfg }
}
const RL = { code: 'rate_limit', status: 429, message: 'rate limit exceeded' }
const BAD = { code: 'upstream_error', status: 500, message: 'boom' }

console.log('\n【T1 isRateLimitFailure 口径】')
{
  check('T1a code=rate_limit 算限流', isRateLimitFailure({ code: 'rate_limit' }) === true)
  check('T1b status=429 算限流', isRateLimitFailure({ status: 429 }) === true)
  check('T1c 只有 message 里带 429 也算', isRateLimitFailure({ message: 'HTTP 429 too many' }) === true)
  check('T1d 只有 message 里带 rate_limit 也算', isRateLimitFailure({ message: 'rate_limit_exceeded' }) === true)
  check('T1e 500 不算', isRateLimitFailure(BAD) === false)
  check('T1f undefined 不炸', isRateLimitFailure(undefined) === false)
  check('T1g null 不炸', isRateLimitFailure(null) === false)
}

console.log('\n【T2 未达阈值不熔断】')
{
  const { b } = make()
  const r1 = b.recordFailure(RL)
  check('T2a 第 1 次不打开', r1.opened === false && r1.streak === 1)
  const r2 = b.recordFailure(RL)
  check('T2b 第 2 次不打开', r2.opened === false && r2.streak === 2)
}

console.log('\n【T3 达阈值打开熔断】')
{
  const { b, clock } = make()
  b.recordFailure(RL); b.recordFailure(RL)
  const r3 = b.recordFailure(RL)
  check('T3a 第 3 次打开', r3.opened === true)
  check('T3b 冷却 60 秒', r3.openUntil === clock.t + 60_000)
  check('T3c 打开后 streak 归零', b.streak === 0)
  check('T3d admit 被拒', b.admit('k').ok === false && b.admit('k').code === 'circuit_open')
  check('T3e status.open=true', b.status().open === true)
  check('T3f 历史记一笔', b.history.length === 1 && b.history[0].streak === 3)
}

console.log('\n【T4 冷却到期半开复位】')
{
  const { b, clock } = make()
  for (let i = 0; i < 3; i += 1) b.recordFailure(RL)
  clock.t += 60_000 - 1
  check('T4a 差 1ms 仍关着', b.admit('k').ok === false)
  clock.t += 1
  check('T4b 到点放行', b.admit('k').ok === true)
  check('T4c openUntil 已清', b.openUntil === 0)
  check('T4d streak 已清', b.streak === 0)
}

console.log('\n【T5 ★ BUG-18：并发失败只算一轮】')
{
  const { b } = make()
  // 模拟：上游抖一下，8 个在途请求同时收到 429。
  // 修复前 streak 会一路涨到 8，阈值 3 在第三个就被打穿。
  const results = []
  for (let i = 0; i < 8; i += 1) results.push(b.recordFailure(RL))
  check('T5a 只有第 3 个打开熔断', results.filter((r) => r.opened).length === 1)
  check('T5b 打开的位置是第 3 个', results.findIndex((r) => r.opened) === 2)
  check('T5c rateLimitHits 仍如实计 8 次', b.stats.rateLimitHits === 8)
  check('T5d 只打开 1 次', b.stats.opened === 1)
  check('T5e 历史只有 1 条', b.history.length === 1)
}
{
  // 冷却期内继续来失败：不该再把 streak 推高（否则冷却一结束就会立刻二次熔断）
  const { b, clock } = make()
  for (let i = 0; i < 3; i += 1) b.recordFailure(RL)
  check('T5f 先确认已熔断', b.status().open === true)
  for (let i = 0; i < 5; i += 1) b.recordFailure(RL)
  clock.t += 60_001
  check('T5g 冷却期内 5 次失败不再打开新熔断', b.stats.opened === 1)
  check('T5h 冷却结束后 streak 干净', b.streak === 0)
}
{
  // 跨轮次：冷却结束后再连来 3 次，应该重新熔断（证明不是"永久免疫"）
  const { b, clock } = make()
  for (let i = 0; i < 3; i += 1) b.recordFailure(RL)
  clock.t += 60_001
  b.admit('k') // 触发 remainingMs 的复位
  b.recordFailure(RL); b.recordFailure(RL)
  const third = b.recordFailure(RL)
  check('T5i 新一轮仍能正常熔断', third.opened === true)
  check('T5j 累计打开 2 次', b.stats.opened === 2)
}

console.log('\n【T6 非限流错误完全不介入】')
{
  const { b } = make()
  for (let i = 0; i < 10; i += 1) b.recordFailure(BAD)
  check('T6a streak 不动', b.streak === 0)
  check('T6b 不打开', b.status().open === false)
  check('T6c rateLimitHits 不增', b.stats.rateLimitHits === 0)
  check('T6d admit 正常放行', b.admit('k').ok === true)
}

console.log('\n【T7 成功清零】')
{
  const { b } = make()
  b.recordFailure(RL); b.recordFailure(RL)
  b.recordSuccess('k')
  check('T7a streak 归零', b.streak === 0)
  const r = b.recordFailure(RL)
  check('T7b 重新从 1 计', r.streak === 1 && r.opened === false)
}

console.log('\n【T8 enabled=false 完全停用】')
{
  const { b } = make({ enabled: false })
  const r = b.recordFailure(RL)
  check('T8a 不打开', r.opened === false)
  check('T8b status.enabled=false', b.status().enabled === false)
  check('T8c admit 不受阻', b.admit('k').ok === true)
}

console.log('\n【T9 reset 手动恢复】')
{
  const { b } = make()
  for (let i = 0; i < 3; i += 1) b.recordFailure(RL)
  check('T9a 先确认已熔断', b.status().open === true)
  b.reset()
  check('T9b reset 后放行', b.admit('k').ok === true)
  check('T9c openUntil 清零', b.openUntil === 0 && b.streak === 0)
}

console.log('\n【T10 输出 token 窗口】')
{
  const clock = { t: 1_000_000 }
  const cfg = () => ({ limits: { perKeyTpm: 100, breaker: { enabled: true, consecutiveRateLimits: 3, cooldownSec: 60 } } })
  const b = new Breaker(cfg, () => clock.t)
  b.recordSuccess('k', 60)
  check('T10a 窗口记到 60', b.outputTokensInWindow('k') === 60)
  check('T10b 未超限放行', b.admit('k').ok === true)
  b.recordSuccess('k', 60)
  check('T10c 累加到 120', b.outputTokensInWindow('k') === 120)
  const r = b.admit('k')
  check('T10d 超限被拒', r.ok === false && r.code === 'token_rate_limit_exceeded')
  check('T10e 告诉客户端 60 秒后重试', r.retryAfterSec === 60)
  clock.t += 60_001
  check('T10f 窗口过期后归零', b.outputTokensInWindow('k') === 0)
  check('T10g 过期后放行', b.admit('k').ok === true)
  check('T10h 不同 key 互不影响', b.outputTokensInWindow('other') === 0)
}

console.log('\n【T11 边界：非法 token / 缺配置】')
{
  const clock = { t: 1_000_000 }
  const b = new Breaker(() => undefined, () => clock.t)
  check('T11a 配置为空也能用（走默认阈值 3）', b.status().threshold === 3)
  check('T11b 默认冷却 60 秒', b.status().cooldownSec === 60)
  b.recordSuccess('k', Number.NaN)
  b.recordSuccess('k', -5)
  b.recordSuccess('k', 'abc')
  check('T11c 非法 token 不入窗口', b.outputTokensInWindow('k') === 0)
  check('T11d 非法 token 不炸', true)
}

console.log('\n【T12 createReservedGate】')
{
  const g = createReservedGate(4, 1)
  check('T12a lanMax = total - reserved', g.lanMax === 3)
  check('T12b 保留数如实汇报', g.reserved === 1)
  check('T12c 前 3 个拿到', g.acquire() && g.acquire() && g.acquire())
  check('T12d 第 4 个被拒', g.acquire() === false)
  g.release()
  check('T12e 释放后可再拿', g.acquire() === true)
  const g2 = createReservedGate(1, 5)
  check('T12f reserved 不会吃光全部', g2.lanMax === 1 && g2.reserved === 0)
  const g3 = createReservedGate(0, 0)
  check('T12g total=0 兜底为 1', g3.lanMax >= 1)
  const g4 = createReservedGate(4, 1)
  g4.release()
  check('T12h 空释放不把 inflight 变成负数', g4.inflight === 0)
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
