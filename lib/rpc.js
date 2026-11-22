/**
 * dsh-lantern — 管理 RPC 层（Host 半部内部模块）。
 *
 * 两条通道**彻底隔离**（设计方案 §11.5.4）：
 *   `/api/lantern`  ← 本机浏览器会话的管理通道（本文件）
 *   `/v1/*`         ← 局域网推理通道（index.js 路由）
 * 管理通道经 DSH 自身 `connection` 闸门（或本机最小围墙），
 * **局域网客户端无法访问**（也拿不到 key、改不了配置）。
 *
 * 方法集见设计方案 §11.5.6.5。全部写入落在插件自己的 `data/`。
 *
 * @module dsh-lantern/rpc
 */
import { fingerprintOf } from './auth.js'
import {
  writeJson,
  PATHS,
  PACKAGE_ROOT,
  LEGACY_DATA_DIR,
  LEGACY_MIGRATION_LOG,
  archiveStats,
} from './storage.js'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  MAX_BACKEND_RETRIES,
  MAX_BACKEND_TIMEOUT_MS,
  MIN_BACKEND_RETRIES,
  MIN_BACKEND_TIMEOUT_MS,
  findCustomModel,
  isValidCustomModelName,
  normalizeCustomModels,
  normalizeDefaultReasoningEffort,
  normalizeReasoningEfforts,
  normalizeRetries,
  normalizeTimeoutMs,
  uniqueCustomModelId,
} from './custom-models.js'
import { LABELS as LABELS_OF_CAPABILITY } from './capabilities.js'
import { DEFAULT_EXPOSURE } from './exposure.js'
import { aggregate, writeReport } from './usage.js'
import { spawn } from 'node:child_process'

/**
 * 把 keyId 映射为 `{ label, fingerprint }`（用量报告与 UI 都要显示"名称 + 指纹"）。
 * 已删除的 Key 会退化成"已删除的 Key（历史用量）"，不让历史数据失去归属。
 *
 * @param deps - RPC 依赖集合。
 * @returns `Map<keyId, { label, fingerprint }>`。
 */
function keyLabelMap(deps) {
  /** @type {Map<string, {label:string, fingerprint:string}>} */
  const map = new Map()
  try {
    for (const k of deps.keyStore.list()) {
      map.set(k.id, { label: k.label ?? '(未命名)', fingerprint: k.fingerprint ?? '' })
    }
  } catch {
    /* keyStore 异常不应影响用量查询 */
  }
  return map
}
function liveModelNames(deps) {
  const live = new Set()
  try {
    const cur = deps.current()
    for (const m of (cur?.customModels ?? [])) {
      if (typeof m?.name === 'string') live.add(m.name)
    }
    for (const e of deps.directory.list()) {
      if (typeof e.publicName === 'string') live.add(e.publicName)
    }
  } catch {
    /* 忽略：空集合 = 全部按在线处理 */
  }
  return live
}
/**
 * 取某个 keyId 的显示名与指纹。
 * @param id - 账本里的 keyId。
 * @param map - `keyLabelMap()` 的结果。
 * @returns `{ label, fingerprint, deleted? }`。
 *
 * ⚠ `deleted` **必须是独立字段**，不能把"已删除"写进 `label`：
 * UI 要据此把整行置灰、并在名称旁放一个 ⓘ 图标（悬停才显示注释）。
 * 若把说明写进 label，那一长串文字会把用量表挤得很难看（用户实测发现）。
 */
function keyNameOf(id, map) {
  const hit = map.get(id)
  if (hit !== undefined) return hit
  if (id === 'anonymous') return { label: '（匿名访问）', fingerprint: '' }
  if (id === 'unknown') return { label: '（未知来源）', fingerprint: '' }
  // 已删除的 Key：名称保持简短，删除状态用 `deleted` 标记（UI 渲染为灰行 + ⓘ）
  return { label: id, fingerprint: '', deleted: true }
}

/**
 * 能力测试的**进行中状态**（进程内存，不落盘）。
 *
 * 为什么需要它：管理 RPC 是"一次请求 → 一次响应"，**无法在响应中途推送进度**；
 * 而能力测试要逐项真实调用模型，可能持续几十秒（图片项最长 30s）。
 * 因此把进度记在这里，由客户端**轮询 `model/testProgress`** 取回，
 * 这样用户能看到"正在测第几项"，而不是干等。
 *
 * 同一时刻只允许一个测试在跑（`running` 为 true 时拒绝新请求），
 * 所以单份状态就够，不需要按 provider/model 建表。
 *
 * @type {{ running: boolean, provider: string, model: string, items: string[], done: string[], total: number, startedAt: number, current: string|null, finishedAt: number|null }}
 */
const testProgress = {
  running: false,
  provider: '',
  model: '',
  /** 本次要测的全部项（用于显示总数）。 */
  items: [],
  /** 已完成的项 id（按完成顺序）。 */
  done: [],
  total: 0,
  startedAt: 0,
  /** 正在进行的项 id（回调触发前的"当前项"）。 */
  current: null,
  finishedAt: null,
}

/**
 * 取当前测试进度快照（供客户端轮询）。
 * @returns 可安全序列化的进度对象。
 */
export function currentTestProgress() {
  return {
    running: testProgress.running,
    provider: testProgress.provider,
    model: testProgress.model,
    total: testProgress.total,
    doneCount: testProgress.done.length,
    done: [...testProgress.done],
    current: testProgress.current,
    elapsedMs: testProgress.startedAt > 0 ? Date.now() - testProgress.startedAt : 0,
    finishedAt: testProgress.finishedAt,
  }
}

/**
 * 用系统默认程序打开一个本地文件（用量报告）。
 *
 * 只在**本机管理通道**被调用（局域网客户端够不到 `/api/lantern`），
 * 且路径由插件自己生成，不接受外部传入——避免变成任意程序执行入口。
 *
 * @param filePath - 报告绝对路径。
 * @returns `{ ok, reason? }`。
 */
function openInBrowser(filePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: `当前平台（${process.platform}）不支持自动打开` })
      return
    }
    try {
      // cmd /c start "" "<file>" —— 空标题参数是必须的，否则含空格的路径会被当成标题
      const child = spawn('cmd.exe', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (error) => resolve({ ok: false, reason: error?.message ?? '启动失败' }))
      child.on('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve({ ok: false, reason: error?.message ?? '启动失败' })
    }
  })
}

/** RPC 端点路径（client 半部按同路径读写）。 */
export const RPC_PATH = '/api/lantern'

/** 请求体上限（管理请求都很小）。 */
const MAX_BODY = 256 * 1024

/**
 * 本机信任围墙：只接受回环地址、且非跨站的请求。
 * 与 harness 自带闸门同一判据（有 `connection` 服务时优先用它）。
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function localOnlyRejection(headers) {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  const h = hostUrl.hostname
  const loopback =
    h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  if (!loopback) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 读 JSON 请求体。
 * @param req - Node 请求。
 * @returns 解析后的对象（失败返回 `{}`）。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size <= MAX_BODY && chunk !== undefined) chunks.push(chunk)
    })
    req.on('end', resolve)
    req.on('error', resolve)
  })
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 发一个 JSON 响应。
 * @param res - Node 响应。
 * @param status - HTTP 状态码。
 * @param body - 响应体。
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * RPC 成功响应包装（client 半部按 `ok/value` 解包）。
 * @param value - 返回值。
 * @returns 包装对象。
 */
function okEnvelope(value) {
  return { ok: true, value }
}

/**
 * RPC 失败响应包装。
 *
 * ⚠ 纪律（本机踩过）：必须返回**规范的 RPC 错误响应**而不是裸 500 文本，
 * 否则 client 半部的 unwrapRpcResult 无法识别，界面表现为"点击无反应"。
 *
 * @param code - 机器码。
 * @param message - 人话消息。
 * @returns 包装对象。
 */
/**
 * 复制一份配置，把**上游密钥**换掉——诊断包要能发出去，就不能带明文。
 *
 * 只擦 `media.providers[].apiKey` 与 `auth` 里可能出现的密钥字段：
 * 其它字段（地址、端点、模型名、限额）恰恰是诊断要看的，不能一并抹掉。
 *
 * @param cfg - 当前配置。
 * @returns 擦过密钥的新对象（不改原对象）。
 */
function redactConfigForExport(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg ?? {}))
  const providers = Array.isArray(copy?.media?.providers) ? copy.media.providers : []
  for (const provider of providers) {
    if (provider !== null && typeof provider === 'object' && provider.apiKey !== undefined && provider.apiKey !== '') {
      provider.apiKey = '***'
      provider.apiKeyRedacted = true
    }
  }
  // 额外的自定义请求头里也可能塞了密钥（Authorization / X-Api-Key 之类）。
  //
  // ⚠ 原来的正则只认 `authorization` / `*-api-key` / `*-token` / `apikey` / `x-goog-api-key`，
  // 而 `X-Custom-Auth`、`X-Auth`、`X-Key`、`Api-Key`（无连字符）、`X-Secret` 全都不匹配。
  // 诊断包是**发出去给别人看**的产物，等于把上游凭证送出去（第十二轮 #134）。
  //
  // 改成**关键词覆盖**：头名里出现 auth / key / token / secret / credential / password
  // 一律打码。宁可误杀一个无害的头名（诊断包里少一个头不致命），
  // 也不能漏掉一个真凭证。
  const SENSITIVE_HEADER = /(auth|key|token|secret|credential|password|passwd|cookie|session|signature|bearer)/i
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object') continue
    const headers = provider.headers
    if (headers === null || typeof headers !== 'object') continue
    for (const name of Object.keys(headers)) {
      const value = typeof headers[name] === 'string' ? headers[name] : ''
      // 头名命中关键词，或者值本身长得像 Bearer/Key，都要打码
      if (SENSITIVE_HEADER.test(name) || /^(bearer|basic|token)\s/i.test(value)) {
        headers[name] = '***'
      }
    }
  }
  return copy
}

function errEnvelope(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 读当前脱敏开关（缺段时按「默认全藏」补齐）。
 *
 * 为什么不在各处直接读 cfg.exposure：老配置里根本没有这一段，
 * 面板要显示「当前是开还是关」，直接读会得到 undefined 而显示成空白，
 * 用户会以为开关坏了。这里统一补默认值。
 *
 * @param cfg - 当前配置。
 * @returns maskTopology 与 maskInternalHints 两个布尔值。
 */
function exposureOf(cfg) {
  const section = cfg?.exposure
  return {
    maskTopology: section?.maskTopology !== false,
    maskInternalHints: section?.maskInternalHints !== false,
  }
}

/**
 * 探测端口是否可用（短暂 listen 后立即释放 —— 只读探测，不留占用）。
 * @param port - 待测端口。
 * @param bind - 绑定地址。
 * @returns `{ available, reason? }`。
 */
export async function probePort(port, bind = '127.0.0.1') {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    server.once('error', (error) => {
      const code = error?.code
      finish({
        available: false,
        reason:
          code === 'EADDRINUSE'
            ? '端口已被占用'
            : code === 'EACCES'
              ? '无权限绑定该端口'
              : `绑定失败：${code ?? error?.message ?? 'unknown'}`,
      })
    })
    server.once('listening', () => finish({ available: true }))
    try {
      server.listen({ port, host: bind === '0.0.0.0' ? undefined : bind })
    } catch (error) {
      finish({ available: false, reason: `绑定失败：${error?.message ?? 'unknown'}` })
    }
  })
}

// #194：自定义工具已下线，checkToolProviderRef 一并移除。

/**
 * 构造管理方法分发器。
 * @param ctx - Host 插件上下文（用于 logger）。
 * @param deps - 依赖集合：配置读写、key 仓库、目录、性能测试等。
 * @returns `(method, payload) => Promise<envelope>`。
 */
export function buildDispatcher(ctx, deps) {
  /**
   * 处理一个 RPC 调用。
   * @param method - 方法名。
   * @param payload - 参数。
   * @returns 包装后的响应。
   */
  return async function dispatch(method, payload) {
    const cfg = deps.current()

    switch (method) {
      // ---------- 状态 ----------
      case 'status': {
        // ── #193 内存诊断 ──
        //
        // 排查"插件跑久内存高"时，光看任务管理器的 400+ MB 没用 ——
        // 那是整个 DSH 进程（Electron + Node + 内核 + 插件）。
        //
        // `process.memoryUsage()` 能分段给出**本进程**的真实构成：
        //   · heapUsed      —— JS 对象（插件的数据结构都在这里）
        //   · heapTotal     —— V8 已向系统申请但未必用完的堆
        //   · external      —— Buffer / TypedArray（图片解码、文件内容）
        //   · arrayBuffers  —— external 的细分（真正的大头常在这）
        //   · rss           —— 进程常驻集（≈ 任务管理器看到的数）
        //
        // 有了这四项才能回答："插件的 0.1 MB 数据，怎么把进程撑到 400 MB？"
        // 答案通常是 external（图片 Buffer）或 heapTotal（V8 预留但未回收）。
        let mem
        try {
          const u = process.memoryUsage()
          const toMB = (b) => Math.round((b / 1024 / 1024) * 10) / 10
          mem = {
            rss: toMB(u.rss),
            heapUsed: toMB(u.heapUsed),
            heapTotal: toMB(u.heapTotal),
            external: toMB(u.external),
            arrayBuffers: toMB(u.arrayBuffers),
            // 插件自己持有的条目数（不是字节，是计数，便于对照）
            counts: {
              attachmentLedger: deps.attachmentCount?.() ?? null,
              capabilityOverrides: deps.capabilityCount?.() ?? null,
              models: Array.isArray(cfg.customModels) ? cfg.customModels.length : 0,
              keys: deps.keyStore.records.length,
            },
          }
        } catch {
          mem = undefined
        }

        return okEnvelope({
          plugin: 'dsh-lantern',
          enabled: cfg.enabled === true,
          config: cfg,
          auth: {
            keyCount: deps.keyStore.records.length,
            usable: deps.keyStore.records.filter((r) => r.enabled !== false).length,
            allowAnonymous: cfg.auth?.allowAnonymous === true,
            format: cfg.auth?.format ?? 'sk',
          },
          listen: deps.listenStatus(),
          inflight: deps.inflight(),
          directory: deps.directory.diagnostics(),
          ...(mem === undefined ? {} : { memory: mem }),
        })
      }

      // ---------- 配置 ----------
      case 'config/get':
        return okEnvelope(cfg)

      case 'config/set': {
        const patch = payload?.config
        if (patch === null || typeof patch !== 'object') {
          return errEnvelope('bad_request', 'config 必须是一个对象')
        }
        // 必须接住返回值：patchConfig 在写盘失败 / 监听重建失败时返回
        // `{ ok: false, message }`。原来这里是裸 await，失败也照样回 ok，
        // 面板显示"已保存"、实际没生效——是最难排查的一类"设置自己变回去"。
        const applied = await deps.patchConfig(patch)
        if (applied !== undefined && applied !== null && applied.ok === false) {
          return errEnvelope('patch_failed', applied.message ?? '配置未生效（原因未知）')
        }
        // 这条是面板改「默认上游供应商 / 默认上游模型」等媒体字段的通道（不是
        // providers/* 那条）。媒体侧一旦被碰到就丢缓存：否则面板上的「可用性 /
        // 上游模型目录」还是改之前那次探测的结论，用户会以为设置没生效。
        if (patch.media !== undefined && patch.media !== null) deps.mediaInvalidate?.()
        return okEnvelope({ config: deps.current() })
      }

      // ---------- 跨域（CORS） ----------
      // 单独一组方法而不是塞进 config/set：这里是**开门器**，需要独立校验
      // （origin 必须是 协议+主机+端口 形态，或 '*'），并要求调用方显式确认。
      case 'cors/get':
        return okEnvelope({
          cors: cfg.cors ?? { enabled: false, allowOrigins: [], allowCredentials: false, maxAgeSec: 600 },
        })

      case 'cors/set': {
        const patch = payload?.cors
        if (patch === null || typeof patch !== 'object') {
          return errEnvelope('bad_request', 'cors 必须是一个对象')
        }
        const origins = patch.allowOrigins
        if (origins !== undefined) {
          if (!Array.isArray(origins)) return errEnvelope('bad_request', 'allowOrigins 必须是字符串数组')
          for (const o of origins) {
            if (typeof o !== 'string' || o.length === 0 || o.length > 253) {
              return errEnvelope('invalid_origin', '来源不合法：' + String(o))
            }
            // 只接受 '*' 或 scheme://host[:port]。不允许带路径/查询/末尾斜杠：
            // 浏览器 Origin 头永远不带这些，带了就永远匹配不上。
            if (o !== '*' && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o)) {
              return errEnvelope(
                'invalid_origin',
                '来源必须形如 https://example.com 或 http://192.168.1.5:8080' +
                  '（不带路径、不带末尾斜杠；全体放行填 *）：' + o,
              )
            }
          }
          // 同一来源去重（用户手滑加两遍不该变成两条）
          patch.allowOrigins = [...new Set(origins)]
        }
        const next = { ...patch }
        if (next.enabled === true) {
          const merged = Array.isArray(next.allowOrigins) ? next.allowOrigins : (cfg.cors?.allowOrigins ?? [])
          if (merged.length === 0) {
            return errEnvelope('bad_request', '开启跨域前至少要填一个允许的来源（填 * 表示全部放行）')
          }
          if (merged.includes('*') && (next.allowCredentials ?? cfg.cors?.allowCredentials) === true) {
            return errEnvelope(
              'bad_request',
              '「允许携带凭证」与「全部放行（*）」互斥：浏览器不接受通配符与凭证同时出现的响应，请填具体来源',
            )
          }
        }
        if (next.allowCredentials !== undefined && typeof next.allowCredentials !== 'boolean') {
          return errEnvelope('bad_request', 'allowCredentials 必须是布尔值')
        }
        if (next.maxAgeSec !== undefined) {
          const n = Number(next.maxAgeSec)
          if (!Number.isFinite(n) || n < 0 || n > 86400) return errEnvelope('bad_request', 'maxAgeSec 必须是 0–86400 的数字')
          next.maxAgeSec = Math.round(n)
        }
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const applied = await deps.patchConfig({ cors: next })
        if (!applied?.ok) return errEnvelope(applied?.code ?? 'apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({ cors: deps.current().cors })
      }
      // ---------- 对外暴露面（脱敏开关） ----------
      // 与 cors 同类：这是**面向客户**的措辞开关，改动会立刻影响所有错误响应，
      // 所以单独成组并在这里校验，而不是让它走 config/set 的裸浅合并。
      case 'exposure/get':
        return okEnvelope({ exposure: exposureOf(cfg) })

      case 'exposure/set': {
        const patch = payload?.exposure
        if (patch === null || typeof patch !== 'object') {
          return errEnvelope('bad_request', 'exposure 必须是一个对象')
        }
        const next = { ...exposureOf(cfg) }
        for (const key of ['maskTopology', 'maskInternalHints']) {
          if (patch[key] === undefined) continue
          if (typeof patch[key] !== 'boolean') {
            return errEnvelope('bad_request', key + ' 必须是布尔值')
          }
          next[key] = patch[key]
        }
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const applied = await deps.patchConfig({ exposure: next })
        if (!applied?.ok) return errEnvelope(applied?.code ?? 'apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({ exposure: exposureOf(deps.current()) })
      }

      // ---------- 监听端口（P14：增删改） ----------
      case 'listen/list':
        return okEnvelope({ entries: deps.listenList(), active: deps.listenStatus() })

      case 'listen/probe': {
        const port = Number(payload?.port)
        const bind = typeof payload?.bind === 'string' ? payload.bind : '127.0.0.1'
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return errEnvelope('bad_request', 'port 必须是 1–65535 的整数')
        }
        return okEnvelope(await probePort(port, bind))
      }

      case 'listen/update': {
        const result = await deps.listenUpdate(payload ?? {})
        return result.ok ? okEnvelope(result.value) : errEnvelope(result.code, result.message)
      }

      // ---------- API Key（P15：增删改） ----------
      case 'keys/list':
        return okEnvelope({
          keys: deps.keyStore.list(),
          format: cfg.auth?.format ?? 'sk',
          allowAnonymous: cfg.auth?.allowAnonymous === true,
        })

      case 'keys/create': {
        const created = await deps.keyStore.create({
          label: typeof payload?.label === 'string' ? payload.label : '',
          limits: payload?.limits ?? null,
        })
        // #227：明文现在会持久化，随时可再查看 —— 提示语跟着改，
        // 不再说"只显示这一次"（那会让人以为关掉就没了）。
        return okEnvelope({
          id: created.record.id,
          label: created.record.label,
          fingerprint: fingerprintOf(created.record),
          plaintext: created.plaintext,
          warning: 'Key 不会过期；明文已保存，之后可在列表里点「查看」随时复制。',
        })
      }

      case 'keys/reveal': {
        // #227：取回明文，供面板「查看 / 复制」。
        // 明文只在这一次响应里出现，列表接口不带它（避免长期留在 DOM 里）。
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const plaintext = deps.keyStore.reveal(id)
        if (plaintext === undefined) {
          return errEnvelope(
            'not_recoverable',
            '这个 Key 是旧版本创建的，当时只存了哈希、没有保存明文，无法再查看。删除它并新建一个即可得到可查看明文的 Key。',
          )
        }
        return okEnvelope({ plaintext })
      }

      case 'keys/update': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const changed = await deps.keyStore.update(id, {
          ...(typeof payload?.label === 'string' ? { label: payload.label } : {}),
          ...(typeof payload?.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          ...(payload?.limits === null || (typeof payload?.limits === 'object' && !Array.isArray(payload.limits)) ? { limits: payload.limits } : {}),
        })
        return changed ? okEnvelope({ keys: deps.keyStore.list() }) : errEnvelope('not_found', '该 Key 不存在')
      }

      case 'keys/remove': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const removed = await deps.keyStore.remove(id)
        return removed ? okEnvelope({ keys: deps.keyStore.list() }) : errEnvelope('not_found', '该 Key 不存在')
      }

      // #227：keys/rotate 已移除 ——
      // Key 现在随时可查看明文，不需要"换一个"；想换就新建 + 删除旧的。
      // 保留过渡期会造成"同一时刻两个有效 Key"，列表状态与实际可用性不一致。

      case 'keys/setAnonymous': {
        const allow = payload?.allow === true
        await deps.patchConfig({ auth: { allowAnonymous: allow } })
        return okEnvelope({
          allowAnonymous: allow,
          warning: allow ? '⚠ 已允许匿名访问：同网段任何人都能使用本机模型额度。' : undefined,
        })
      }

      // ---------- 能力（P4） ----------
      case 'model/capabilities': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        return okEnvelope({
          capabilities: await deps.capabilities.describe(providerId, modelId),
          labels: LABELS_OF_CAPABILITY,
        })
      }

      case 'model/capability/set': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        const field = typeof payload?.field === 'string' ? payload.field : ''
        if (providerId.length === 0 || modelId.length === 0 || field.length === 0) {
          return errEnvelope('bad_request', '缺少 provider / model / field')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        // value 传 null 表示"恢复权威值"（清除人工覆盖）
        const value = payload?.value ?? null
        const done = await deps.capabilities.setOverride(providerId, modelId, field, value)
        if (!done) return errEnvelope('bad_request', 'value 必须是 supported / unsupported / unknown 或 null')
        return okEnvelope({ capabilities: await deps.capabilities.describe(providerId, modelId) })
      }

      case 'model/test': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        // 同一时刻只允许一个测试：否则进度状态会被两个测试互相覆盖，
        // 且会并发消耗上游额度。
        if (testProgress.running) {
          return errEnvelope('busy', `已有测试正在进行（${testProgress.model || '未知模型'}），请等它结束`)
        }
        const testCfg = cfg.capabilities?.test ?? {}
        const items = Array.isArray(payload?.items) ? payload.items : testCfg.items
        // 元素要过白名单：capabilities.test 只认这 6 项，其它值会被
        // #probeOne 的 default 分支当成"未知项"，而 authoritative 会被直接跳过——
        // 传 ['authoritative'] 就得到一个"测试完成但 0 项"的假成功。
        // 客户端本来就只发这 6 项，这里挡的是别的调用方。
        const KNOWN_TEST_ITEMS = ['connectivity', 'systemMerge', 'tools', 'temperature', 'jsonMode', 'stop', 'image']
        const itemList = (Array.isArray(items) ? items : [])
          .filter((item) => typeof item === 'string' && KNOWN_TEST_ITEMS.includes(item))
          .filter((item, at, arr) => arr.indexOf(item) === at)
        if (itemList.length === 0) {
          return errEnvelope('bad_request', 'items 至少要包含一项：' + KNOWN_TEST_ITEMS.join(' / '))
        }
        // 初始化进度（客户端据此显示"第几项 / 共几项"）
        testProgress.running = true
        testProgress.provider = providerId
        testProgress.model = modelId
        testProgress.items = itemList
        testProgress.total = itemList.length
        testProgress.done = []
        testProgress.current = itemList[0] ?? null
        testProgress.startedAt = Date.now()
        testProgress.finishedAt = null
        try {
          const results = await deps.capabilities.test({
            provider: providerId,
            model: modelId,
            items,
            perItemTimeoutMs: Number.isFinite(testCfg.perItemTimeoutMs) ? testCfg.perItemTimeoutMs : 30_000,
            // ⚠ 逐项回调：每完成一项就记录，客户端轮询可见。
            // （之前 RPC 没转发这个回调，导致进度永远停在"第 1 项"。）
            onProgress: (item) => {
              // ⚠ **必须排除 `authoritative`**：它是零成本的"权威值刷新"前置步骤，
              // 由 capabilities.test() 在正式项之前额外 emit 一次，**不在 itemList 里**。
              // 若把它计入 done，就会出现 done=7 / total=6 的荒谬显示（用户实测反馈）。
              if (typeof item === 'string' && item !== 'authoritative') testProgress.done.push(item)
              // 把"当前项"推进到下一个尚未完成的
              const next = itemList.find((x) => !testProgress.done.includes(x))
              testProgress.current = next ?? null
            },
          })
          // ── #182：systemMerge 探针的结论**自动写回模型配置** ──
          //
          // 这个开关不是"能力"（不进 capabilities 覆盖），而是**模型配置项**
          // （`customModels[].mergeSystemIntoUser`），所以走单独的写回路径。
          //
          // 只在探针给出**明确建议**时才写：`recommended` 为空表示"测不出来"
          // （两种形状都空，多半是限流/故障），那种情况绝不能瞎改配置。
          let systemMergeApplied
          try {
            const mergeProbe = Array.isArray(results)
              ? results.find((r) => r?.item === 'systemMerge')
              : undefined
            const want = mergeProbe?.recommended?.mergeSystemIntoUser
            if (typeof want === 'boolean' && deps.applySystemMerge !== undefined) {
              systemMergeApplied = await deps.applySystemMerge(providerId, modelId, want)
            }
          } catch { /* 写回失败不影响测试结果 */ }

          return okEnvelope({
            results,
            capabilities: await deps.capabilities.describe(providerId, modelId),
            note: '「测试」会真实调用模型（消耗上游额度）',
            ...(systemMergeApplied === undefined ? {} : { systemMergeApplied }),
          })
        } finally {
          // 全部清空而不是只清 3 项：testProgress 是**全局单例**，残留的
          // done/provider/model/items/total 会被下一个模型的轮询读到——
          // 表现为"刚点开测试，进度条已经 6/6"。
          testProgress.running = false
          testProgress.current = null
          testProgress.finishedAt = Date.now()
          testProgress.done = []
          testProgress.total = 0
          testProgress.items = []
          testProgress.provider = ''
          testProgress.model = ''
          testProgress.startedAt = 0
        }
      }

      /** 轮询能力测试进度（配合 model/test 使用，见 testProgress 注释）。 */
      case 'model/testProgress': {
        return okEnvelope(currentTestProgress())
      }

      // ---------- provider / 模型 ----------
      case 'models/list': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        if (providerId.length === 0) return errEnvelope('bad_request', '缺少 provider')
        const models = deps.directory.list().filter((m) => m.provider === providerId)
        return okEnvelope({
          provider: providerId,
          models: models.map((m) => ({
            publicName: m.publicName,
            model: m.model,
            name: m.name,
            description: m.description,
            inputModalities: m.inputModalities,
          })),
        })
      }

      // ---------- 性能测试（§6.5.10-b） ----------
      case 'model/perf': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        const perfCfg = cfg.perfTest ?? {}
        const timeoutMs = Number.isFinite(perfCfg.timeoutMs) ? perfCfg.timeoutMs : 20_000
        const result = await deps.perfTest({ provider: providerId, model: modelId, timeoutMs })
        return okEnvelope(result)
      }

      // ---------- 配置复位（P16 危险操作） ----------
      case 'config/reset': {
        // 恢复出厂默认设置。**不动 API Key 与用量账本**（用户数据不该被"复位设置"带走）。
        const keepKeys = payload?.keepKeys !== false
        const reset = await deps.resetConfig?.(keepKeys)
        if (reset === undefined) return errEnvelope('unavailable', '复位不可用')
        if (!reset.ok) return errEnvelope('apply_failed', reset.message ?? '复位失败')
        return okEnvelope({
          config: deps.current(),
          keptKeys: keepKeys ? deps.keyStore.records.length : 0,
          note: keepKeys
            ? '已恢复出厂默认设置；API Key 与用量账本未动。'
            : '已恢复出厂默认设置。',
        })
      }

      // ---------- 过滤（P16 / §4.4 + §7.3） ----------
      case 'filters/get': {
        const f = deps.current()?.filters ?? {}
        const diag = deps.directory.diagnostics()
        return okEnvelope({
          filters: {
            providers: f.providers ?? [],
            models: f.models ?? [],
            allowedModels: f.allowedModels ?? [],
          },
          // 实际生效的结果：让人一眼看出"过滤器真的起作用了没有"
          publicCount: diag.publicCount,
          hiddenModelCount: diag.hiddenModelCount,
          hiddenModels: diag.hiddenModels.slice(0, 200),
          hiddenProviders: diag.allProviders.filter((p) => !p.visible).map((p) => ({ id: p.id, reason: p.hiddenReason })),
          note:
            'providers / models 是黑名单（命中即不公开）；allowedModels 是白名单' +
            '（非空时只公开其中的，空 = 全部）。两种写法都认：公开名 <模型>@<provider> 或裸模型名。',
        })
      }

      case 'filters/set': {
        const patch = {}
        for (const key of ['providers', 'models', 'allowedModels']) {
          if (payload?.[key] !== undefined) {
            if (!Array.isArray(payload[key])) return errEnvelope('bad_request', `${key} 必须是数组`)
            patch[key] = payload[key].map((x) => String(x)).filter((x) => x.length > 0)
          }
        }
        if (Object.keys(patch).length === 0) return errEnvelope('bad_request', '没有要修改的字段')
        const applied = await deps.patchConfig({ filters: patch })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        // 立即刷新目录，让过滤结果当场可见（不必等下一次轮询）
        // 目录刷新失败不等于配置失败：上面 patchConfig 已经落盘并生效，
        // 这里抛错会让调用方以为整次设置没成功、再点一次
        //（而每次都失败，因为失败原因是上游 listModels，不是这条配置）。
        try {
          await deps.directory.refresh()
        } catch (refreshError) {
          deps.log?.('warn', "[lantern] 过滤已保存，但目录刷新失败：" + (refreshError?.message ?? refreshError))
        }
        const diag = deps.directory.diagnostics()
        return okEnvelope({
          filters: deps.current()?.filters ?? {},
          publicCount: diag.publicCount,
          hiddenModelCount: diag.hiddenModelCount,
        })
      }

      // ---------- 熔断与并发（P12） ----------
      case 'breaker/status':
        if (deps.breaker === undefined) return errEnvelope('unavailable', '熔断器未就绪')
        return okEnvelope({
          ...deps.breaker.status(),
          concurrency: deps.concurrencyStatus?.() ?? null,
          note:
            '熔断只在上游连续限流时触发，用于保护本机 DSH 不被局域网刷量拖垮。' +
            '冷却期内 LAN 请求立即被拒（不消耗上游额度）；本机自己的对话不受影响。',
        })

      case 'breaker/reset': {
        if (deps.breaker === undefined) return errEnvelope('unavailable', '熔断器未就绪')
        const before = deps.breaker.status()
        deps.breaker.reset()
        return okEnvelope({
          before: { open: before.open, remainingSec: before.remainingSec },
          after: deps.breaker.status(),
          note: '已手动解除熔断（清空连续限流计数）。若上游仍在限流，很快会再次触发。',
        })
      }

      // ---------- 后端健康记忆 ----------
      // 与 breaker 是两个层次：熔断管「整条 LAN 通道暂停」，这里管「链上谁排前面」。
      // 放在面板里是因为它解释了一个原本很反直觉的现象：
      // 改完上游配置后第一次请求仍然很快失败（旧冷却还在），用户会认为"改配置没用"。
      case 'backendHealth/status':
        if (deps.backendHealth === undefined) return errEnvelope('unavailable', '后端健康记忆未就绪')
        return okEnvelope({
          ...deps.backendHealth.status(),
          note:
            '故障转移链会记住刚失败过的后端，把它们在冷却期内排到链尾——' +
            '这样后续请求不必为同一个已知故障再等满一次超时。冷却到期自动回到原位，不是禁用。' +
            '只影响顺序，链上的后端一个都不会少。',
        })

      case 'backendHealth/reset': {
        if (deps.backendHealth === undefined) return errEnvelope('unavailable', '后端健康记忆未就绪')
        const before = deps.backendHealth.status()
        const after = deps.backendHealth.reset()
        return okEnvelope({
          before: { cooling: before.cooling, tracked: before.tracked },
          after,
          note: '已清空后端健康记忆，所有后端恢复配置顺序。若某一档确实不可用，很快会再次进入冷却。',
        })
      }

      // ---------- 用量（P9） ----------
      case 'usage/summary': {
        const granularity = typeof payload?.granularity === 'string' ? payload.granularity : 'monthly'
        // #235：可选时间范围（最近 N 天 / 自定义区间）。
        // payload 给 `rangeDays`（最近 N 天）或 `fromMs`/`toMs`。
        const rangeDays = Number.isFinite(payload?.rangeDays) && payload.rangeDays > 0
          ? Math.min(3650, Math.round(payload.rangeDays))
          : undefined
        const fromMs = rangeDays !== undefined
          ? Date.now() - rangeDays * 24 * 3600_000
          : (Number.isFinite(payload?.fromMs) ? Number(payload.fromMs) : undefined)
        const toMs = rangeDays !== undefined
          ? Date.now()
          : (Number.isFinite(payload?.toMs) ? Number(payload.toMs) : undefined)
        const agg = await aggregate({ granularity, fromMs, toMs })
        const keyLabels = keyLabelMap(deps)
        return okEnvelope({
          // 回包必须用**实际生效**的粒度：认不出的粒度会回落到 daily，
          // 但这里早先回的是入参原值，于是客户端以为自己拿到按年数据、实际是按天。
          granularity: agg.granularity,
          granularityRequested: agg.granularityRequested,
          granularityFellBack: agg.granularityFellBack,
          windowKey: agg.windowKey,
          // #235：当前汇总口径是"当期窗口"还是"自定义区间"
          rangeDays: rangeDays ?? null,
          rangeFrom: agg.rangeFrom,
          rangeTo: agg.rangeTo,
          totals: agg.totals,
          // ── #231：标记"已删除的 Key / 已下线的模型" ──
          //
          // 账本是**追加流水**：Key 删了、模型从绑定里移除了，历史行还在。
          // 于是「按 API Key」「按模型」两张表会冒出已经不存在的对象，
          // 占着 Token 排行，让人误以为还在用。
          //
          // 做法：**不删账本行**（那是审计流水），只加标记，
          // 由面板默认折叠、可一键展开看历史 —— 比直接抹掉更诚实。
          //
          // Key：不在 keyStore 里 → deleted
          keys: agg.keys.map((k) => ({
            ...k,
            ...keyNameOf(k.id, keyLabels),
            deleted: k.id !== 'anonymous' && k.id !== 'unknown' && !keyLabels.has(k.id),
          })),
          providers: agg.providers,
          // #224：面板也要能回答"哪个模型最费 token"。
          // `aggregate()` 一直在算 `models`，但这里只透出了 `providers` ——
          // 于是面板只能按 Key / 类型看，最常问的那个问题反而答不了。
          //
          // #231：同时标记 offline（当前目录里已经没有这个 provider+model）。
          // 只给 Top 12 时**优先保留在线模型**，否则一个已下线但历史用得多的模型
          // 会把真正在用的挤出榜单。
          // #234：按"用户请求的模型名"汇总 —— 这才是用户心智里的"模型"。
          // （原来按 provider+model 聚合，显示的是 trae@deepseek-v4.1-flash 这种
          //   上游坐标，跟用户配的模型名对不上，也没法回答"我这个模型花了多少"。）
          //
          // 「在线」判断也一并简化：拿请求名直接跟"当前可用的模型名集合"比。
          //   · 自定义模型名（customModels[].name）
          //   · DSH 公开名（directory 的 publicName）
          // 用户删掉 hy4 → "hy4" 不在集合里 → offline，默认隐藏。
          models: (() => {
            const live = new Set()
            try {
              const cur = deps.current()
              for (const m of (cur?.customModels ?? [])) {
                if (typeof m?.name === 'string') live.add(m.name)
              }
              for (const e of deps.directory.list()) {
                if (typeof e.publicName === 'string') live.add(e.publicName)
              }
            } catch {
              /* 目录异常：不标 offline，宁可多显示 */
            }
            const rows = agg.requested
              .filter((x) => x.calls > 0)
              .map((x) => ({
                name: x.name,
                calls: x.calls,
                failed: x.failed,
                total: x.total,
                hitRate: x.hitRate,
                offline: live.size > 0 && !live.has(x.name),
              }))
              .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
            // 在线优先；同组内按总量降序（sort 已保证）
            return rows.filter((x) => !x.offline).concat(rows.filter((x) => x.offline)).slice(0, 12)
          })(),
          modelCount: agg.models.filter((x) => x.calls > 0).length,
          // ── #228：Key × 模型 交叉表 ──
          //
          // 原来的两张表（按 Key / 按模型）无法回答"哪个 Key 在打哪个模型"，
          // 而这恰恰是排查"某人的 Key 把贵的模型刷爆了"时的第一问。
          //
          // 数据来源：agg.cells（已经是 bucket × provider × model × key × kind 的
          // 最细粒度聚合），按 keyId+model 再合一次即可，零额外扫描。
          // 只保留 total > 0 的组合，并按合计降序取前 40 —— 面板是概览，
          // 完整交叉表看报告。
          cross: (() => {
            const m = new Map()
            for (const c of agg.cells) {
              if ((c.total ?? 0) <= 0) continue
              const key = `${c.keyId}\u0000${c.model}`
              let row = m.get(key)
              if (row === undefined) {
                row = { keyId: c.keyId, model: c.model, provider: c.provider, calls: 0, total: 0, failed: 0 }
                m.set(key, row)
              }
              row.calls += c.calls ?? 0
              row.total += c.total ?? 0
              row.failed += c.failed ?? 0
            }
            return [...m.values()]
              .sort((a, b) => b.total - a.total)
              .slice(0, 40)
              .map((r) => ({
                ...r,
                ...keyNameOf(r.keyId, keyLabels),
                deleted: r.keyId !== 'anonymous' && r.keyId !== 'unknown' && !keyLabels.has(r.keyId),
              }))
          })(),
          // #228：环比 —— 面板卡片显示"本月 668M（↑12%）"比裸数字有用得多。
          // 算法：从按月聚合的 cells 里取上月那个桶的合计。
          // 用 cells 而不是另跑一次 aggregate：already 在内存里，零额外 IO。
          prevMonth: (() => {
            if (granularity !== 'monthly') return undefined
            const keys = agg.bucketKeys
            if (keys.length < 2) return undefined
            // bucketKeys 已按字典序排序（YYYY-MM），当前月的上一个就是倒数第二
            const cur = agg.windowKey
            const idx = keys.indexOf(cur)
            const prevKey = idx > 0 ? keys[idx - 1] : undefined
            if (prevKey === undefined) return undefined
            let total = 0
            let calls = 0
            for (const c of agg.cells) {
              if (c.bucketKey !== prevKey) continue
              total += c.total ?? 0
              calls += c.calls ?? 0
            }
            return { key: prevKey, total, calls }
          })(),
          // #234：按「用户请求的模型名」汇总 —— 这才是用户心智里的"模型"。
          // 新账本的 requestedModel 直接可用；老账本由上面的 resolveName 反查，
          // 查不到则保留真实坐标。
          requested: agg.requested
            .filter((x) => x.calls > 0)
            .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
            .slice(0, 12)
            .map((x) => ({
              name: x.name,
              calls: x.calls,
              failed: x.failed,
              total: x.total,
              hitRate: x.hitRate,
            })),
          requestedCount: agg.requested.filter((x) => x.calls > 0).length,
          // #235：每个模型最近 N 个桶的合计，供面板画迷你趋势图。
          // 只给 Top 12 模型（与按模型表一致）—— 全量会撑大回包。
          modelTrends: (() => {
            const top = agg.requested
              .filter((x) => x.calls > 0)
              .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
              .slice(0, 12)
            const byName = new Map()
            for (const x of agg.requestedBuckets) {
              const arr = byName.get(x.name)
              if (arr === undefined) byName.set(x.name, [])
              else arr.push({ key: x.bucketKey, total: x.total })
            }
            const out = {}
            for (const t of top) {
              const series = byName.get(t.name) ?? []
              // 只取最近 12 个桶，避免月初/月末差异太大导致图不可比
              out[t.name] = series.slice(-12)
            }
            return out
          })(),
          // #234：本月日均 —— 比环比更能看出"这段用量是集中在某天还是平稳"。
          // 分母用"本月已过天数"（含今天），避免月初时被满月天数稀释。
          monthDailyAvg: (() => {
            if (granularity !== 'monthly') return undefined
            const dayOfMonth = new Date().getDate()
            return { total: agg.totals.total, days: dayOfMonth, avg: Math.round((agg.totals.total ?? 0) / Math.max(1, dayOfMonth)) }
          })(),
          kinds: agg.kinds,
          range: agg.range,
          empty: agg.totals.lines === 0,
        })
      }

      case 'usage/report': {
        const cfgNow = deps.current()
        const reuseWithinMs = Math.max(0, Number(cfgNow?.usage?.reuseWithinSec ?? 60) * 1000)
        const keep = Number(cfgNow?.usage?.keepReports ?? 20)
        const result = await writeReport({ keyLabels: keyLabelMap(deps), reuseWithinMs, keep, liveNames: liveModelNames(deps) })
        return okEnvelope({
          path: result.path,
          reused: result.reused,
          note: result.reused ? '一分钟内已生成过报告，直接复用（避免连点生成多份）' : '已生成新报告',
        })
      }

      case 'usage/open': {
        const cfgNow = deps.current()
        const reuseWithinMs = Math.max(0, Number(cfgNow?.usage?.reuseWithinSec ?? 60) * 1000)
        const keep = Number(cfgNow?.usage?.keepReports ?? 20)
        const result = await writeReport({ keyLabels: keyLabelMap(deps), reuseWithinMs, keep, liveNames: liveModelNames(deps) })
        const opened = await openInBrowser(result.path)
        return okEnvelope({
          path: result.path,
          reused: result.reused,
          opened: opened.ok,
          ...(opened.ok ? {} : { openError: opened.reason }),
        })
      }

      case 'usage/setEnabled': {
        const value = payload?.value === true
        const applied = await deps.patchConfig({ usage: { enabled: value } })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({ enabled: value })
      }

      // ---------- 附件账本（P8） ----------
      case 'attachments/status':
        if (deps.ledger === undefined) return errEnvelope('unavailable', '附件账本未就绪')
        return okEnvelope({
          ...deps.ledger.status(),
          note:
            'dry-run 时只记日志不真删。三道防误删：①复用本机对象绝不记账 ②删除前扫会话引用 ③删除前校验内容 sha256。',
        })

      case 'attachments/sweep': {
        if (deps.ledger === undefined) return errEnvelope('unavailable', '附件账本未就绪')
        const dryRun = payload?.dryRun
        const summary = await deps.ledger.sweep(
          typeof dryRun === 'boolean' ? { dryRun } : undefined,
        )
        return okEnvelope(summary)
      }

      case 'attachments/setDryRun': {
        const value = payload?.value === true
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const applied = await deps.patchConfig({ attachments: { dryRun: value } })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({
          dryRun: value,
          warning: value
            ? undefined
            : '⚠ 已关闭 dry-run：账本将真的删除自己新建且无人引用的附件对象（复用本机对象仍永不删除）。',
        })
      }

      // ---------- 诊断 ----------
      case 'storage/status': {
        // #238：数据目录状态 —— 面板展示用。
        //
        // 为什么专门做一个 RPC：用户曾因"不知道数据存在哪"而丢过全部 Key
        // （数据当时在插件包内，一次重装被整体覆盖）。现在数据在包外，
        // 但用户依然需要**在界面上直接看到**路径与各文件是否就绪，
        // 而不是去翻 README 或猜目录。
        const files = {}
        for (const [key, p] of Object.entries({
          config: PATHS.config,
          keys: PATHS.keys,
          usage: PATHS.usage,
          capabilities: PATHS.capabilities,
          attachmentLedger: PATHS.attachmentLedger,
        })) {
          try {
            const st = statSync(p)
            files[key] = { exists: true, bytes: st.size, at: st.mtimeMs }
          } catch {
            files[key] = { exists: false, bytes: 0, at: null }
          }
        }
        // 旧版数据目录（插件包内）是否仍有残留
        let legacy = null
        try {
          if (LEGACY_DATA_DIR !== PATHS.data && existsSync(LEGACY_DATA_DIR)) {
            legacy = {
              path: LEGACY_DATA_DIR,
              files: readdirSync(LEGACY_DATA_DIR).filter((f) => !f.startsWith('.')),
            }
          }
        } catch {
          /* 目录不可读则视为不存在 */
        }
        return okEnvelope({
          dir: PATHS.data,
          packageRoot: PACKAGE_ROOT,
          files,
          legacy,
          migrated: [...LEGACY_MIGRATION_LOG],
          // #239：账本归档（`usage-archive-*.jsonl`）的统计。
          // 这些**不会被自动删除**（是用户的历史用量数据），但必须可见 ——
          // 否则用户永远不知道磁盘被它们占了多少。
          archives: await archiveStats(),
          // 累积的损坏隔离副本数量（超过 5 个会被 sweepCorruptions 清理）
          corruptions: (() => {
            try {
              return readdirSync(PATHS.data).filter((f) => /\.corrupt-\d+$/.test(f)).length
            } catch {
              return 0
            }
          })(),
          // 首次使用或数据丢失时的判定依据
          needsKey: deps.keyStore.records.length === 0,
        })
      }

      case 'diagnostics/export': {
        // 脱敏：不含 key、不含 prompt 正文
        const report = {
          generatedAt: new Date().toISOString(),
          plugin: 'dsh-lantern',
          // ⚠ 这里原来直接写 `config: cfg`：注释说"不含 key"，但
          // `cfg.media.providers[].apiKey` 是明文上游密钥，会被原样写进
          // data/diagnostics.json 并随返回值一起交给发起导出的人——
          // 一份"诊断包"发出去等于把上游密钥一起发出去。
          config: redactConfigForExport(cfg),
          directory: deps.directory.diagnostics(),
          auth: {
            keyCount: deps.keyStore.records.length,
            usable: deps.keyStore.records.filter((r) => r.enabled !== false).length,
            keys: deps.keyStore.list(), // 只含指纹，无明文
          },
          listen: deps.listenStatus(),
          node: process.version,
          platform: process.platform,
        }
        await writeJson(PATHS.diagnostics, report)
        return okEnvelope({ path: PATHS.diagnostics, report })
      }

      // ---------- 自定义模型（虚拟模型名 + 多后端故障转移） ----------
      case 'customModels/list': {
        const models = normalizeCustomModels(cfg.customModels)
        return okEnvelope({
          models: models.map((m) => ({
            ...m,
            // 绑定当前是否可用：面板要据此高亮"已失效"的绑定，
            // 而不是等用户发请求失败了才发现。
            bindingStatus: m.bindings.map((binding) => {
              const resolved = deps.resolveBinding?.(binding)
              return {
                binding,
                available: resolved !== undefined && resolved.error === undefined,
                ...(resolved === undefined || resolved.error === undefined
                  ? {}
                  : { reason: resolved.reason, code: resolved.error }),
                ...(resolved?.error === undefined && resolved?.provider !== undefined
                  ? { provider: resolved.provider, model: resolved.model }
                  : {}),
              }
            }),
          })),
        })
      }

      case 'customModels/candidates': {
        // 面板要"勾选绑定"，就得先知道全部可绑定的真实模型
        //（用公开名 <model>@<provider>，与请求时填写的形式完全一致）。
        const models = deps.directory.list().map((m) => ({
          publicName: m.publicName,
          provider: m.provider,
          providerName: m.providerName ?? m.provider,
          model: m.model,
          name: m.name ?? m.model,
          description: m.description,
        }))
        return okEnvelope({ models })
      }

      case 'customModels/create': {
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        if (!isValidCustomModelName(name)) {
          return errEnvelope(
            'invalid_name',
            '模型名只能包含字母、数字、下划线、点、连字符、斜杠，长度 1–64，且不能含 @',
          )
        }
        const models = normalizeCustomModels(cfg.customModels)
        if (models.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
          return errEnvelope('duplicate_name', `已存在同名模型：${name}`)
        }
        // 去重：同一个绑定在链里出现两次，意味着第一次失败后会在同一个后端上
        // 再失败一次，白白多等一轮超时——链越长这个代价越明显。
        const bindings = Array.isArray(payload?.bindings)
          ? payload.bindings
              .map((b) => String(b).trim())
              .filter((b) => b.length > 0)
              .filter((b, i, arr) => arr.indexOf(b) === i)
          : []
        const entry = {
          id: uniqueCustomModelId(models, name),
          name,
          display: typeof payload?.display === 'string' && payload.display.trim().length > 0
            ? payload.display.trim()
            : name,
          bindings,
          enabled: payload?.enabled !== false,
          // 调优参数：非法值收敛为默认，绝不因此拒绝保存整个模型（见 custom-models.js 的理由）。
          timeoutMs: normalizeTimeoutMs(payload?.timeoutMs),
          retries: normalizeRetries(payload?.retries),
          // 推理档位的按模型配置（第十轮 #118）。缺省 = 不限制 / 不干预。
          reasoningEfforts: normalizeReasoningEfforts(payload?.reasoningEfforts),
          ...(normalizeDefaultReasoningEffort(payload?.defaultReasoningEffort) === undefined
            ? {}
            : { defaultReasoningEffort: normalizeDefaultReasoningEffort(payload?.defaultReasoningEffort) }),
          createdAt: Date.now(),
        }
        const applied = await deps.patchConfig({ customModels: [...models, entry] })
        if (applied !== undefined && applied.ok === false) {
          return errEnvelope('apply_failed', applied.message ?? '写入配置失败')
        }
        return okEnvelope({ model: entry, models: normalizeCustomModels(deps.current().customModels) })
      }

      case 'customModels/update': {
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const id = String(payload?.id ?? '')
        const models = normalizeCustomModels(cfg.customModels)
        const found = models.find((m) => m.id === id)
        if (found === undefined) return errEnvelope('not_found', '该自定义模型不存在')

        const next = { ...found }
        let renamedFrom = undefined
        if (payload?.name !== undefined) {
          const name = String(payload.name).trim()
          if (!isValidCustomModelName(name)) {
            return errEnvelope(
              'invalid_name',
              '模型名只能包含字母、数字、下划线、点、连字符、斜杠，长度 1–64，且不能含 @',
            )
          }
          if (models.some((m) => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
            return errEnvelope('duplicate_name', `已存在同名模型：${name}`)
          }
          renamedFrom = found.name
          next.name = name
          // 显示名跟着改名走：只有「显示名本来就等于旧模型名」（也就是从没单独设过）
          // 才跟着改。用户自己起过的显示名（如「主力·快速」）不能因为改模型名被冲掉。
          // 早先这里不动 display，结果改名之后面板和 /v1/models 还在显示旧名字，
          // 看起来像"改了个寂寞"——而这恰恰是改名功能最容易被当成没生效的地方。
          if (payload?.display === undefined && next.display === renamedFrom) {
            next.display = name
          }
        }
        if (payload?.display !== undefined) {
          next.display = String(payload.display).trim().length > 0 ? String(payload.display).trim() : next.name
        }
        if (payload?.bindings !== undefined) {
          if (!Array.isArray(payload.bindings)) return errEnvelope('bad_request', 'bindings 必须是数组')
          next.bindings = payload.bindings
            .map((b) => String(b).trim())
            .filter((b) => b.length > 0)
            .filter((b, i, arr) => arr.indexOf(b) === i)
        }
        if (payload?.enabled !== undefined) next.enabled = payload.enabled !== false
        if (payload?.timeoutMs !== undefined) {
          next.timeoutMs = normalizeTimeoutMs(payload.timeoutMs)
        }
        if (payload?.retries !== undefined) {
          next.retries = normalizeRetries(payload.retries)
        }
        // 推理档位的按模型配置（第十轮 #118）。
        if (payload?.reasoningEfforts !== undefined) {
          // 传空数组 = 取消白名单（恢复"不限制"），这是**有意义的显式动作**，
          // 不能被 `!== undefined` 之外的判断吞掉。
          next.reasoningEfforts = normalizeReasoningEfforts(payload.reasoningEfforts)
        }
        if (payload?.defaultReasoningEffort !== undefined) {
          const dflt = normalizeDefaultReasoningEffort(payload.defaultReasoningEffort)
          if (dflt === undefined) delete next.defaultReasoningEffort
          else next.defaultReasoningEffort = dflt
        }
        // 白名单与默认档必须自洽：默认档不在白名单里就剔除它，
        // 否则运行时会"按默认档走"却立刻被自己的白名单拒掉。
        if (Array.isArray(next.reasoningEfforts) && next.reasoningEfforts.length > 0
            && next.defaultReasoningEffort !== undefined
            && !next.reasoningEfforts.includes(next.defaultReasoningEffort)) {
          delete next.defaultReasoningEffort
        }

        const updated = models.map((m) => (m.id === id ? next : m))
        const applied = await deps.patchConfig({ customModels: updated })
        if (applied !== undefined && applied.ok === false) {
          return errEnvelope('apply_failed', applied.message ?? '写入配置失败')
        }
        return okEnvelope({ model: next, models: normalizeCustomModels(deps.current().customModels) })
      }

      case 'customModels/remove': {
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const id = String(payload?.id ?? '')
        const models = normalizeCustomModels(cfg.customModels)
        const next = models.filter((m) => m.id !== id)
        if (next.length === models.length) return errEnvelope('not_found', '该自定义模型不存在')
        const applied = await deps.patchConfig({ customModels: next })
        if (applied !== undefined && applied.ok === false) {
          return errEnvelope('apply_failed', applied.message ?? '写入配置失败')
        }
        return okEnvelope({ models: normalizeCustomModels(deps.current().customModels) })
      }

      case 'customModels/test': {
        // 逐绑定做一次极小的真实调用（只让它回一个字），
        // 这样面板上的"绑定是否可用"是**实测**结果，不是猜的。
        if (deps.bindingTest === undefined) return errEnvelope('unavailable', '测试能力未就绪')
        const id = String(payload?.id ?? '')
        const model = findCustomModel(deps.current(), id) ?? normalizeCustomModels(deps.current().customModels).find((m) => m.id === id)
        if (model === undefined) return errEnvelope('not_found', '该自定义模型不存在')
        const results = []
        for (const binding of model.bindings) {
          results.push({ binding, ...(await deps.bindingTest(binding)) })
        }
        return okEnvelope({ id: model.id, name: model.name, results })
      }

      // ---------- 自定义工具（对外工具名 + 钉死宿主工具 / 上游模型） ----------






      // ---------- 上游供应商（媒体往哪家打） ----------
      // 独立成一组成员而不是塞进 config/set：这一整块决定"扣谁的额度、往哪个
      // 地址发图"，写坏了等于把网关指到错的地方。逐条校验比裸浅合并安全得多。







      default:
        return errEnvelope('unknown_method', `未知方法：${String(method)}`)
    }
  }
}

/**
 * 安装管理通道。
 *
 * ⚠ **必须用 `connection.fetch.register`，不能用 `webServer.register`**：
 * client 半部的 `ctx.connection.rpc.call('/api', endpoint, …)` 走的是
 * DSH 自身的 RPC 信封协议（`{type:'client-request', rpcId, method, payload}`），
 * 由 `connection.fetch.register` 认领；用 webServer 注册会拿不到该信封，
 * 表现为「面板点不动 / 无反应」（本机 jet-hub 同款实现可证）。
 *
 * @param ctx - Host 插件上下文。
 * @param deps - 依赖集合。
 * @param rpcMethod - RPC endpoint 名（client 侧一致）。
 * @returns `{ installed, dispose }`。
 */
export function installManagementRpc(ctx, deps, rpcMethod = 'lantern') {
  // ⚠ 只能读已经注入的服务：`ctx.get('connection')` 在未声明 inject 时会抛
  //   "cannot get property \"connection\" without inject"（本机实测）。
  //   因此本函数由调用方在已 `ctx.inject(['connection'], …)` 的作用域内调用，
  //   或直接接收 connection 对象。
  const connection = deps.connection
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[lantern] connection.fetch 不可用，管理通道未注册（设置面板将无法读写）')
    return { installed: false, dispose: () => {} }
  }

  /**
   * 构造带 rpcId 的**规范**响应 JSON。
   *
   * ⚠ 必须包含 `type: 'server-response'`（本机实测踩坑）：
   * 缺了它，client 侧抛 `connection: invalid server-response envelope`，
   * 界面表现为**永远卡在"读取中…"**（而不是报错），极难排查。
   * 参考实现：`dsh-codearts-auth/lib/jet-hub-rpc.js` 的 reply()。
   * @param rpcId - 对应请求 id。
   * @param result - `{ ok: true, value }` 或 `{ ok: false, error }`。
   * @returns Response。
   */
  const reply = (rpcId, result) => {
    const value =
      result !== null && typeof result === 'object' && result.ok === false
        ? { ...result, error: { ...result.error, details: {} } }
        : result
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result: value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const registration = connection.fetch.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload
      if (
        message.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== rpcMethod ||
        !call ||
        typeof call.method !== 'string' ||
        !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid LANtern management request.' } })
      }
      try {
        const result = await dispatchMethod(ctx, deps, call.method, call.payload)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回**规范的 RPC 错误响应**（不是裸 500 文本），
        // 否则 client 的 unwrap 无法识别，界面表现为"点击无反应"。
        const message2 = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[lantern] ${String(call.method)} failed: ${message2}`)
        return reply(rpcId, { ok: false, error: { code: 'handler-failed', message: maskForClient(message2) } })
      }
    },
  })

  return {
    installed: true,
    dispose: () => {
      try {
        registration?.()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 分发一个管理方法（供 `connection.fetch` 通道使用）。
 * @param ctx - Host 上下文。
 * @param deps - 依赖集合。
 * @param method - 方法名。
 * @param payload - 参数。
 * @returns `{ ok, value }` 或 `{ ok:false, error }`。
 */
export async function dispatchMethod(ctx, deps, method, payload) {
  return buildDispatcher(ctx, deps)(method, payload)
}

/**
 * 脱敏一段可能含密钥的消息（管理通道用）。
 * @param message - 原始消息。
 * @returns 脱敏后的消息。
 */
/**
 * 内置媒体能力（生图 / 生视频）的展示条目。
 *
 * 它们不是配置里的 customTools —— 是插件内置的直连后端。这里包成和自定义工具
 * 一样的形状，只为了让面板能把「我手上到底有哪些媒体能力」一次列全；
 * `builtin: true` 是给前端的判据：不许删除、不许改 kind、不写进配置。
 *
 * @param kind - 'image' 或 'video'。
 * @param probed - `{ available, reason?, models?, backend? }`。
 * @param catalog - 上游媒体模型目录（`listMediaModels()` 的结果）。
 * @returns 展示条目。
 */
function builtinMediaEntry(kind, probed, catalog) {
  const tags = kind === 'image' ? ['text-to-image', 'image-to-image'] : ['text-to-video', 'image-to-video']
  const models = Array.isArray(probed?.models) ? probed.models : []
  // 注意 catalog 的形状来自 upstream-media 的 selectMediaModels()：
  // 每项是 { id, name, tags, videoGeneration? }，**不是** capabilities —— 视频的
  // 分辨率 / 时长约束还嵌在 videoGeneration 里，要摊平出来才方便前端直接用。
  // （早先按 capabilities 过滤，结果一条都筛不出来，下拉自然是空的。）
  const rows = Array.isArray(catalog)
    ? catalog
        .filter((entry) => {
          const labels = Array.isArray(entry?.tags) ? entry.tags : []
          return labels.some((label) => tags.includes(label))
        })
        .map((entry) => {
          const video = entry?.videoGeneration ?? {}
          const row = {
            id: entry?.id ?? '',
            ...(entry?.name === undefined || entry.name === entry.id ? {} : { display: entry.name }),
            ...(Array.isArray(entry?.tags) ? { tags: entry.tags } : {}),
          }
          for (const key of ['resolutions', 'aspectRatios', 'defaultResolution', 'defaultAspectRatio', 'defaultSeconds', 'minSeconds', 'maxSeconds', 'maxPromptLength']) {
            if (video[key] !== undefined) row[key] = video[key]
          }
          return row
        })
        .filter((row) => row.id.length > 0)
    : []
  return {
    builtin: true,
    kind,
    // 公开名就是请求里能填的那个虚拟 id（workbuddy-image / workbuddy-video）。
    name: kind === 'image' ? 'workbuddy-image' : 'workbuddy-video',
    display: kind === 'image' ? '内置生图' : '内置生视频',
    backend: probed?.backend ?? 'unknown',
    available: probed?.available === true,
    ...(typeof probed?.reason === 'string' && probed.reason.length > 0 ? { reason: probed.reason } : {}),
    models,
    catalog: rows,
    endpoints:
      kind === 'image'
        ? ['/v1/images/generations', '/v1/images/edits']
        : ['/v1/videos', '/v1/videos/{id}', '/v1/videos/{id}/content', '/v1/videos/generations'],
    // 把它变成一条可命名、可钉模型的自定义工具时，前端预填的模板。
    template: {
      kind,
      tool: '',
      name: kind === 'image' ? 'my-image' : 'my-video',
      model: models.length === 1 ? models[0] : '',
    },
  }
}

function maskForClient(message) {
  return String(message ?? 'internal error')
    .replace(/\b(sk|npm|ghp|xoxb|glm|hf)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***')
}
