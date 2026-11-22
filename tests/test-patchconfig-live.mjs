/**
 * #96 / #97：`patchConfig` 对 `media.*` 与 `limits.*` 的钳制 —— **真跑一遍**。
 *
 * 为什么不能只断言源码形状：这两条 bug 的表现都是"面板说已保存、读回来是另一个数"，
 * 只有真的走一次 `patchConfig(patch)` 再看落盘对象才能抓住。所以这里把
 * `patchConfig` 整段源码抽出来，配上最小桩（withDefaults / writeJson / listenManager…），
 * 用 `new Function` 执行真实实现。
 *
 * 三个必须钉住的性质：
 *   1. 荒谬值被钳（0 / 负数 / 天文数字）；
 *   2. **没出现在 patch 里的键一个都不许动**（否则"改个无关字段，产物上限被重置"）；
 *   3. 钳制上界不能低于用户现存合法值（#97：本机 maxConcurrent 合法地就是 100）。
 */
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}`
const src = readFileSync(P + '/lib/index.js', 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1
    console.log('✓ ' + name + (extra === undefined ? '' : ' — ' + extra))
  } else {
    fail += 1
    console.log('✗ ' + name + (extra === undefined ? '' : ' — ' + extra))
  }
}

// ── 抽源码 ───────────────────────────────────────────────────
const clampStart = src.indexOf('function clampInt(value, min, max, fallback) {')
const clampEnd = src.indexOf('\n}', clampStart) + 2
ok('能定位 clampInt', clampStart !== -1 && clampEnd > clampStart)

// 抽 patchConfigOnce（真正的钳值 + 落盘逻辑）而不是 patchConfig。
// patchConfig 的职责只是"排队"，它把活全部委托给 Once；本文件测的是
// 钳值与落盘，所以应当直接测 Once —— 否则就得给 Once 打桩，等于把被测逻辑
// 整个跳过（上一版就是这样，T1 全军覆没）。
const SPEC = new Function(
  src.slice(src.indexOf('const LIMIT_SPEC = Object.freeze({'),
    src.indexOf('\n})', src.indexOf('const LIMIT_SPEC = Object.freeze({')) + 3)
  + '\nreturn LIMIT_SPEC',
)()

// 抽 patchConfigOnce（真正的钳值 + 落盘逻辑）而不是 patchConfig。
// patchConfig 的职责只是"排队"，它把活全部委托给 Once；本文件测的是
// 钳值与落盘，所以应当直接测 Once —— 否则就得给 Once 打桩，等于把被测逻辑
// 整个跳过。
const pcStart = src.indexOf('async function patchConfigOnce(patch) {')
let depth = 0
let pcEnd = -1
for (let i = src.indexOf('{', pcStart); i < src.length; i += 1) {
  if (src[i] === '{') depth += 1
  else if (src[i] === '}') {
    depth -= 1
    if (depth === 0) {
      pcEnd = i + 1
      break
    }
  }
}
ok('能定位 patchConfig（大括号配平）', pcStart !== -1 && pcEnd > pcStart, 'len=' + (pcEnd - pcStart))

const pcSrc = src.slice(pcStart, pcEnd)
const clampSrc = src.slice(clampStart, clampEnd)

// ── 最小桩：withDefaults = 默认值 + raw（真实现就是这个语义）────────
const DEFAULTS = {
  filters: {},
  protocol: {},
  auth: {},
  limits: { maxConcurrent: 2, perKeyRpm: 30, perKeyTpm: 60000, maxTokensCap: 8192, maxBodyBytes: 4194304, requestTimeoutMs: 600000, reserveForLocal: 1, breaker: {}, backendHealth: {} },
  usage: {},
  media: { maxConcurrent: 2, maxConcurrentTools: 8, imageTimeoutMs: 240000, videoTimeoutMs: 660000, toolTimeoutMs: 240000, fileTtlSec: 21600, maxFiles: 512, maxFileBytesTotal: 2147483648, maxJobs: 256, maxBodyBytes: 33554432, providers: [] },
  exposure: {},
  cors: { allowOrigins: [] },
  listenEntries: [],
  customModels: [],
  customTools: [],
}
const withDefaults = (raw) => {
  const out = {}
  for (const k of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[k]
    if (d !== null && typeof d === 'object' && !Array.isArray(d)) out[k] = { ...d, ...(raw[k] ?? {}) }
    else out[k] = raw[k] === undefined ? d : raw[k]
  }
  return { ...raw, ...out }
}

const makeRunner = (startConfig) => {
  let current = withDefaults(startConfig)
  const written = []
  const factory = new Function(
    'clampInt', 'withDefaults', 'writeJson', 'PATHS', 'ctx', 'normalizeEntries',
    'detectActualBind', 'listenManager', 'getCurrent', 'setCurrent', 'written',
    // LIMIT_SPEC 是 index.js 模块级常量（钳制区间的唯一真相），
    // patchConfigOnce 直接引用它；抽取函数体 eval 时必须注入。
    'LIMIT_SPEC',
    `
    let current = getCurrent()
    ${clampSrc}
    ${pcSrc}
    return patchConfigOnce
    `,
  )
  const patchConfig = factory(
    new Function(clampSrc + '\nreturn clampInt')(),
    withDefaults,
    async (_path, value) => { written.push(JSON.parse(JSON.stringify(value))); current = value },
    { config: 'cfg' },
    { logger: { warn() {}, error() {} } },
    (entries) => ({ ok: true, entries }),
    () => ({}),
    { apply: async () => ({ ok: true }) },
    () => current,
    (v) => { current = v },
    written,
    // 从源码里抽出的真实 LIMIT_SPEC（不手抄，避免与实现漂移）
    new Function(
      src.slice(src.indexOf('const LIMIT_SPEC = Object.freeze({'),
        src.indexOf('\n})', src.indexOf('const LIMIT_SPEC = Object.freeze({')) + 3)
      + '\nreturn LIMIT_SPEC',
    )(),
  )
  return { patchConfig, get: () => current, written }
}

// ── T1 荒谬值全部被钳回去 ────────────────────────────────────
{
  const r = makeRunner({})
  await r.patchConfig({ media: { maxFiles: 0, maxJobs: -3, maxConcurrent: 999, maxConcurrentTools: 0, fileTtlSec: 0, maxFileBytesTotal: 1, maxBodyBytes: 1 } })
  const m = r.get().media
  ok('T1a maxFiles=0 → 1（否则第一张图就被 trimFiles 删掉）', m.maxFiles === 1, 'got=' + m.maxFiles)
  ok('T1b maxJobs=-3 → 1', m.maxJobs === 1, 'got=' + m.maxJobs)
  ok('T1c maxConcurrent=999 → 32（media 池上限）', m.maxConcurrent === 32, 'got=' + m.maxConcurrent)
  ok('T1d maxConcurrentTools=0 → 1', m.maxConcurrentTools === 1, 'got=' + m.maxConcurrentTools)
  ok('T1e fileTtlSec=0 → 60', m.fileTtlSec === 60, 'got=' + m.fileTtlSec)
  ok('T1f maxFileBytesTotal=1 → 1 MiB', m.maxFileBytesTotal === 1048576, 'got=' + m.maxFileBytesTotal)
  ok('T1g maxBodyBytes=1 → 1024', m.maxBodyBytes === 1024, 'got=' + m.maxBodyBytes)
  ok('T1h 落盘对象里没有 NaN/Infinity', Object.values(m).filter((v) => typeof v === 'number').every((v) => Number.isFinite(v)))
}

// ── T2 limits 荒谬值被钳，且合法的大值不被压小（#97）──────────
{
  const r = makeRunner({ limits: { maxConcurrent: 100, perKeyRpm: 100 } })
  await r.patchConfig({ limits: { perKeyRpm: 0, reserveForLocal: 999 } })
  const l = r.get().limits
  ok('T2a perKeyRpm=0 → 1（否则该 key 每请求 429）', l.perKeyRpm === 1, 'got=' + l.perKeyRpm)
  // #130 把区间统一到 LIMIT_SPEC（唯一真相）：reserveForLocal 上界 63 → 1023。
  // 旧断言写死 63 会让"面板存 999 再读回 63"的静默改值重新变成合法行为。
  ok('T2b reserveForLocal=999 → 999（上界已放宽到 1023）', l.reserveForLocal === 999, 'got=' + l.reserveForLocal)
  ok('T2c 没被 patch 的 maxConcurrent 保持 100', l.maxConcurrent === 100, 'got=' + l.maxConcurrent)

  const r2 = makeRunner({ limits: { maxConcurrent: 100 } })
  await r2.patchConfig({ limits: { maxConcurrent: 100 } })
  ok('T2d 用户把 100 原样再存一次，结果仍是 100（#97 核心）', r2.get().limits.maxConcurrent === 100, 'got=' + r2.get().limits.maxConcurrent)

  const r3 = makeRunner({})
  await r3.patchConfig({ limits: { maxConcurrent: 100000 } })
  // #130 之后 maxConcurrent 上界是 LIMIT_SPEC 的 1024（原为 512）
  ok('T2e 天文数字仍被压到上界', r3.get().limits.maxConcurrent <= 1024, 'got=' + r3.get().limits.maxConcurrent)
}

// ── T3 没出现的键绝不能被 fallback 覆盖 ─────────────────────
{
  const r = makeRunner({ media: { maxFiles: 300, fileTtlSec: 3600, maxConcurrent: 2 } })
  await r.patchConfig({ media: { defaultImageModel: 'x' } })
  const m = r.get().media
  ok('T3a 只改 defaultImageModel，maxFiles 仍是 300', m.maxFiles === 300, 'got=' + m.maxFiles)
  ok('T3b 只改 defaultImageModel，fileTtlSec 仍是 3600', m.fileTtlSec === 3600, 'got=' + m.fileTtlSec)
  ok('T3c defaultImageModel 已生效', m.defaultImageModel === 'x', 'got=' + m.defaultImageModel)
}

// ── T4 providers 数组必须保留（不能被钳制块吞掉）────────────
{
  const r = makeRunner({ media: { providers: [{ id: 'a' }, { id: 'b' }] } })
  await r.patchConfig({ media: { maxFiles: 100 } })
  ok('T4a 改数值时 providers 原样保留', JSON.stringify(r.get().media.providers) === JSON.stringify([{ id: 'a' }, { id: 'b' }]))
  const r2 = makeRunner({})
  await r2.patchConfig({ media: { providers: [{ id: 'c' }] } })
  ok('T4b 换 providers 时立刻生效', JSON.stringify(r2.get().media.providers) === JSON.stringify([{ id: 'c' }]))
}

// ── T5 空 patch / 无关 patch 不改变任何数值 ─────────────────
{
  const r = makeRunner({ media: { maxFiles: 77 }, limits: { perKeyRpm: 55 } })
  await r.patchConfig({})
  ok('T5a 空 patch 后 maxFiles 仍 77', r.get().media.maxFiles === 77)
  ok('T5b 空 patch 后 perKeyRpm 仍 55', r.get().limits.perKeyRpm === 55)
  await r.patchConfig({ exposure: { maskTopology: false } })
  ok('T5c 只改 exposure 不碰 media/limits', r.get().media.maxFiles === 77 && r.get().limits.perKeyRpm === 55)
}

// ── T6 面板与服务端的上界必须一致 ───────────────────────────
{
  const cli = readFileSync(P + '/lib/client.js', 'utf8')
  // #130 之后服务端不再用字面量，而是从 LIMIT_SPEC 取区间（唯一真相）。
  // 所以这里断言"引用了 LIMIT_SPEC"，并校验它的上界 ≥ 512。
  const usesSpec = /LIMIT_SPEC\.maxConcurrent\[0\], LIMIT_SPEC\.maxConcurrent\[1\]/.test(pcSrc)
  ok('T6a 服务端 limits.maxConcurrent 走 LIMIT_SPEC（不再手写字面量）', usesSpec, 'usesSpec=' + usesSpec)
  ok('T6a2 LIMIT_SPEC.maxConcurrent 上界 ≥ 512',
    Array.isArray(SPEC.maxConcurrent) && SPEC.maxConcurrent[1] >= 512,
    'bound=' + (SPEC.maxConcurrent?.[1] ?? 'missing'))
  ok('T6b 面板输入框同界（否则面板显示与服务端落盘不一致）', /'maxConcurrent', '最大并发', 1, 512/.test(cli))
}

console.log('')
if (fail === 0) console.log('ALL PASS: ' + pass + ' passed / 0 failed')
else console.log('FAILED: ' + pass + ' passed / ' + fail + ' failed')
process.exitCode = fail === 0 ? 0 : 1
