/**
 * dsh-lantern — 附件账本（P8）。
 *
 * 背景（设计方案 §7.5，**已查实**）：
 * DSH 的 `~/.dsh/attachments/v1` **没有任何垃圾回收**（官方注释原文：
 * *"may stay unreachable until a future retention policy collects them"*），
 * 且中转请求**不建会话**，因此 LAN 写入的附件是**纯孤儿**——永远没人引用、没人清理。
 * 于是**由本插件承担回收责任**（档 B：转发缓存）。
 *
 * ⚠ 三道防误删（缺一不可，宁可漏删留垃圾，绝不误删破坏本机）：
 *   ① **写入前判定"新建 / 复用"**：对象名 = 内容 sha256，若本机已有同内容对象，
 *      `saveImages()` 会**复用**它（EEXIST 去重）——此时**绝不记账、永不删除**；
 *   ② **删除前扫描 `sessions/`**：本机会话仍在引用该 id → 跳过；
 *   ③ **删除前校验**对象名 == 内容 sha256（防手改/串号）。
 *
 * 另有多重保险：
 *   - 只删**账本内自己新建**的 id，**绝不遍历 objects/ 删未知对象**；
 *   - 延迟回收（默认 5 分钟，覆盖重试与流式响应窗口）；
 *   - 引用计数（并发请求共享同一对象时，等最后一个请求结束再计时）；
 *   - **默认 dry-run**（只记日志不真删），观察期后由用户显式切换；
 *   - 每次回收写审计日志。
 *
 * @module dsh-lantern/attachments
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readJson, writeJson, PATHS } from './storage.js'

/** 对象 id 形态：`sha256:<64 位小写十六进制>`。 */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/**
 * 解析 attachmentId，取出 64 位十六进制摘要。
 * @param attachmentId - 形如 `sha256:abc…`。
 * @returns 摘要，或 undefined（形态非法）。
 */
export function digestOf(attachmentId) {
  const match = ID_PATTERN.exec(String(attachmentId ?? ''))
  return match?.[1]
}

/**
 * DSH 附件对象根目录（与 `dsh-attachment-local` 的规则一致：
 * `DSH_HOME/attachments/v1/objects/<前2位>/<64位>`）。
 * @returns 绝对路径。
 */
export function objectsRoot() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'attachments', 'v1', 'objects')
}

/**
 * 由摘要推出对象绝对路径。
 * @param digest - 64 位十六进制。
 * @returns 绝对路径。
 */
export function objectPathOf(digest) {
  return join(objectsRoot(), digest.slice(0, 2), digest)
}

/**
 * 计算一段字节的内容摘要（与 DSH 的 attachmentId 口径一致）。
 * @param data - 字节。
 * @returns 64 位十六进制。
 */
export function digestOfBytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 附件账本。
 */
export class AttachmentLedger {
  /**
   * @param ctx - Host 插件上下文（用于 logger 与 attachments 服务）。
   * @param config - 返回当前配置的函数。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Array<{id:string,digest:string,createdAt:number,releasedAt:number|null,refCount:number,reused:boolean,bytes:number}>} */
    this.entries = []
    this.loaded = false
    this.timer = undefined
    this.disposed = false
    /** 审计日志（内存里保留最近若干条，便于诊断页展示）。 */
    this.audit = []
  }

  /** 从磁盘载入。 */
  async load() {
    const doc = await readJson(PATHS.attachmentLedger, { version: 1, entries: [] })
    this.entries = Array.isArray(doc?.entries) ? doc.entries : []
    this.loaded = true
    return this.entries.length
  }

  /** 落盘（只写插件自己的 data/）。 */
  async persist() {
    await writeJson(PATHS.attachmentLedger, {
      version: 1,
      entries: this.entries,
      updatedAt: Date.now(),
    })
  }

  /** 记一条审计。 */
  #audit(message) {
    const line = `${new Date().toISOString()} ${message}`
    this.audit.push(line)
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500)
    this.ctx.logger.info(`[lantern][attachment] ${message}`)
  }

  /**
   * 写入一批图片，并按"新建/复用"分别记账。
   *
   * **关键**：必须在 `saveImages()` **之前**判断对象是否已存在，
   * 据此区分"我们新建的"（可回收）与"复用本机已有的"（永不删）。
   *
   * @param images - `[{ data: Uint8Array, mediaType: string }]`。
   * @returns 图片引用数组。
   */
  async save(images) {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw Object.assign(new Error('本机附件服务不可用'), { lanternCode: 'attachments_unavailable' })
    }
    // ① 写入**之前**判定：该内容是否已存在（存在即会被 saveImages 复用）
    const planned = []
    for (const image of images) {
      const digest = digestOfBytes(image.data)
      let existed = false
      try {
        const info = await stat(objectPathOf(digest))
        existed = info.isFile()
      } catch {
        existed = false
      }
      planned.push({ digest, bytes: image.data.byteLength, existed })
    }

    const refs = await attachments.saveImages(images)

    for (const [index, ref] of refs.entries()) {
      const plan = planned[index]
      const digest = digestOf(ref.attachmentId) ?? plan?.digest
      if (digest === undefined) continue
      // ② 先看账本里有没有这一条。
      //
      // **顺序很关键**：必须"先查账本，再处理借用"。
      // 早先是反的（借用先 `continue`），于是这个序列会删掉正在用的图：
      //   请求 A 存图 → refCount 1；A 结束 release → refCount 0、releasedAt 置位；
      //   请求 B 存同一张图 → 文件还在，`saveImages` 复用它（`existed=true`）→
      //   旧代码直接 `continue`，**refCount 还是 0**；随后 sweep 认为无人引用 → 删文件，
      //   而 B 手里正拿着这个引用 → B 的后续读取 ENOENT。
      // 换句话说「复用」不等于「不引用」：只要这次请求要用它，就得 +1。
      const existing = this.entries.find((e) => e.digest === digest)
      if (existing !== undefined) {
        existing.refCount += 1
        existing.releasedAt = null
        if (plan?.existed === true) {
          this.#audit(
            `borrowed existing object ${digest.slice(0, 12)}…（复用了本机已存在的文件，引用计数 +1）`,
          )
        }
        continue
      }
      if (plan?.existed === true) {
        // ③ 文件在我们账本之外就存在（别的程序放的 / 账本被清过）→ 不是我们建的，
        //    永不删；只记审计便于诊断。
        this.#audit(`borrowed foreign object ${digest.slice(0, 12)}…（非本账本创建，不回收）`)
        continue
      }
      this.entries.push({
        id: String(ref.attachmentId),
        digest,
        bytes: plan?.bytes ?? ref.bytes ?? 0,
        createdAt: Date.now(),
        releasedAt: null,
        refCount: 1,
        reused: false,
      })
    }
    await this.persist()
    return refs
  }

  /**
   * 请求结束：引用计数递减，归零才开始计时。
   * @param refs - 本次请求用到的图片引用（`save()` 的返回值）。
   */
  async release(refs) {
    let changed = false
    for (const ref of refs ?? []) {
      const digest = digestOf(ref?.attachmentId)
      if (digest === undefined) continue
      const entry = this.entries.find((e) => e.digest === digest)
      if (entry === undefined || entry.reused === true) continue
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount === 0) entry.releasedAt = Date.now()
      changed = true
    }
    if (changed) await this.persist()
  }

  /**
   * 扫描本机会话日志，判断某 id 是否仍被引用（第②道防护）。
   *
   * 会话文件是**多帧 zstd**，这里做的是"尽力而为"的扫描：
   * 命中即视为被引用（保守），**宁可漏删也不误删**。
   *
   * @param digest - 内容摘要。
   * @returns 是否被任何会话引用。
   */
  async referencedByAnySession(digest) {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    const sessionsRoot = join(home, 'sessions')
    const needle = `sha256:${digest}`
    const files = []
    const walk = async (dir, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) files.push(full)
      }
    }
    await walk(sessionsRoot, 0)

    const { zstdDecompressSync } = await import('node:zlib')
    for (const file of files) {
      try {
        const buf = await readFile(file)
        let text
        if (file.endsWith('.zstd')) {
          // 多帧：逐个魔数位置尝试解压，任一帧命中即算引用
          try {
            text = zstdDecompressSync(buf).toString('utf8')
          } catch {
            text = ''
          }
          if (!text.includes(needle)) {
            // 逐帧扫描：找 zstd 魔数 28 B5 2F FD
            for (let i = 0; i + 3 < buf.length; i += 1) {
              if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
                try {
                  const frame = zstdDecompressSync(buf.subarray(i)).toString('utf8')
                  if (frame.includes(needle)) return true
                } catch {
                  /* 单帧失败继续 */
                }
              }
            }
          }
        } else {
          text = buf.toString('utf8')
        }
        if (text.includes(needle)) return true
      } catch {
        /* 单文件失败不影响判定（保守：失败时不以"未引用"论处——见下方调用点的处理） */
        this.#audit(`warning: 无法读取会话文件 ${file}，本次回收将保守跳过相关项`)
        return true
      }
    }
    return false
  }

  /**
   * 校验对象存在且其内容 sha256 == 对象名（第③道防护）。
   * @param digest - 内容摘要。
   * @returns 是否校验通过（可安全删除）。
   */
  async verifyDigest(digest) {
    try {
      const buf = await readFile(objectPathOf(digest))
      return digestOfBytes(buf) === digest
    } catch {
      return false
    }
  }

  /**
   * 一次性扫描 sessions 目录，建立「被引用的 digest 集合」（#192 性能修复）。
   *
   * ── 为什么必须批量 ──
   * 原来的 `referencedByAnySession(digest)` 是**每条账本记录调一次**，
   * 每次都要：递归遍历 sessions 目录（141 文件 / 296 MB）+ 逐个 zstd 解压。
   * 实测**单次 2,286 ms**，而账本有 526 条 → 一轮 sweep ≈ **20 分钟**。
   * 而 sweep 每 5 分钟触发一次 —— **比执行间隔还长，等于一直在跑**，
   * 持续占满 I/O 与事件循环，这就是「DSH 跑久了整体卡顿」的最大原因。
   *
   * 现在：整轮 sweep 只扫一次，把命中过的 digest 汇总成 Set，
   * 之后每条记录 O(1) 查表。526 条从 20 分钟 → 约 2–3 秒。
   *
   * @returns 被会话引用过的 digest 集合（不含 `sha256:` 前缀）。
   */
  async #buildSessionRefIndex() {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    const sessionsRoot = join(home, 'sessions')
    const files = []
    const walk = async (dir, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) files.push(full)
      }
    }
    await walk(sessionsRoot, 0)

    /** 被会话引用过的 digest（不含 `sha256:` 前缀）。 */
    const refs = new Set()
    const DIGEST_RE = /sha256:([0-9a-f]{64})/g

    /**
     * 从一段文本里提取所有 digest。
     * @param text - 任意文本片段。
     */
    const collect = (text) => {
      let m
      while ((m = DIGEST_RE.exec(text)) !== null) refs.add(m[1])
      DIGEST_RE.lastIndex = 0
    }

    // ⚠ 动态 import 会拖慢首次调用；提前取好。
    // 优先用**流式** API（createZstdDecompress），拿不到才退回 sync 版本。
    let createDecompress
    let syncDecompress
    try {
      const zlib = await import('node:zlib')
      createDecompress = zlib.createZstdDecompress
      syncDecompress = zlib.zstdDecompressSync
    } catch {
      createDecompress = undefined
      syncDecompress = undefined
    }

    /**
     * 流式解压一个 zstd 文件并扫描其中的 digest。
     *
     * 为什么不用 sync：实测 148 个文件压缩后 305 MB，整块解压产物约 1.2 GB，
     * 全部先进内存再扫 —— 这是 external 500 MB+ 的主要来源。
     * 流式只保留当前块（默认 64 KB），峰值内存与文件大小无关。
     *
     * @param file - 文件路径。
     * @returns 是否成功处理（false 表示格式不支持，调用方跳过）。
     */
    const scanZstdStreaming = async (file) => {
      if (createDecompress === undefined) return false
      const { createReadStream } = await import('node:fs')
      return await new Promise((resolve) => {
        let settled = false
        const done = (ok) => { if (!settled) { settled = true; resolve(ok) } }
        try {
          const stream = createReadStream(file).pipe(createDecompress())
          stream.on('data', (chunk) => {
            try {
              collect(chunk.toString('utf8'))
            } catch { /* 单块解码失败继续 */ }
          })
          stream.on('end', () => done(true))
          stream.on('error', () => {
            // 多帧 zstd 会让整体解压失败 → 交给 sync 逐帧兜底
            try { stream.destroy() } catch { /* */ }
            done(false)
          })
        } catch {
          done(false)
        }
      })
    }

    /**
     * 多帧 zstd 的逐帧兜底（仅在大文件流式失败时走）。
     * 限制尝试次数，避免逐字节扫描把 CPU 吃满。
     */
    const scanZstdFrames = (buf) => {
      if (syncDecompress === undefined) return
      let tried = 0
      for (let i = 0; i + 3 < buf.length; i += 1) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
          tried += 1
          if (tried > 64) {
            this.#audit('warning: zstd 帧数超过 64，停止逐帧扫描（索引可能不完整）')
            return
          }
          try {
            collect(syncDecompress(buf.subarray(i)).toString('utf8'))
          } catch { /* 单帧失败继续 */ }
        }
      }
    }

    // 单文件流式处理的阈值：小于 1 MB 的直接读（快的多），大的走流式。
    const SMALL_FILE = 1024 * 1024

    for (const file of files) {
      // ── 明文 .jsonl：直接读（本来就是文本，无需解压）──
      if (file.endsWith('.jsonl')) {
        try {
          collect((await readFile(file)).toString('utf8'))
        } catch {
          this.#audit(`warning: 无法读取会话文件 ${file}，按"无引用"处理`)
        }
        continue
      }

      // ── .zstd ──
      if (syncDecompress === undefined && createDecompress === undefined) continue

      let size = 0
      try { size = (await stat(file)).size } catch { /* */ }

      if (size > SMALL_FILE && createDecompress !== undefined) {
        // 大文件：流式（峰值内存恒定，不随文件大小增长）
        const ok = await scanZstdStreaming(file)
        if (ok) continue
        // 流式失败（多帧）：退回同步逐帧，但有尝试次数上限
        try {
          scanZstdFrames(await readFile(file))
        } catch {
          this.#audit(`warning: 无法读取会话文件 ${file}，按"无引用"处理`)
        }
        continue
      }

      // 小文件：直接解压（比开流的开销小）
      let buf
      try {
        buf = await readFile(file)
      } catch {
        this.#audit(`warning: 无法读取会话文件 ${file}，按"无引用"处理`)
        continue
      }
      if (syncDecompress === undefined) continue
      try {
        collect(syncDecompress(buf).toString('utf8'))
      } catch {
        // 多帧：逐帧兜底
        scanZstdFrames(buf)
      }
    }
    // 同时返回扫描的文件数：调用方据此判断"索引为空"是真的没引用、
    // 还是引用格式变了导致一个都没匹配上（后者不该自动删）。
    return { refs, files: files.length }
  }

  /**
   * 回收一轮。
   *
   * @param options - `{ dryRun }`（默认取配置 `attachments.dryRun`，默认 true）。
   * @returns `{ scanned, reclaimed, skipped, errors, dryRun }`。
   */
  async sweep({ dryRun } = {}) {
    const cfg = this.config()
    const attCfg = cfg?.attachments ?? {}
    const delayMs = Number.isFinite(attCfg.reclaimDelayMs) ? attCfg.reclaimDelayMs : 5 * 60 * 1000
    const useDryRun = dryRun ?? attCfg.dryRun !== false
    const checkSessions = attCfg.checkSessionRefs !== false

    const now = Date.now()
    const summary = { scanned: 0, reclaimed: 0, skipped: 0, errors: 0, dryRun: useDryRun, details: [] }
    let removedAny = false

    // ── #200：先筛出"真正需要会话检查"的条目，没有就整轮跳过建索引 ──
    //
    // 这是 #198 之后暴露出的下一个热点。实测进程静置（完全无请求）时
    // CPU 仍占 16–25%，线程级分析显示多个 libuv 线程在忙（FS/zstd）。
    //
    // 根因：sweep 每 5 分钟无条件调 `#buildSessionRefIndex()`，
    // 那要遍历 148 个会话文件、zstd 解压 305 MB 压缩数据 ——
    // **哪怕账本里一条可回收的记录都没有**。
    //
    // 实测当前环境账本只剩 2 条，且都是 refCount>0（还在用）。
    // 那种情况下连"哪些条目需要查会话"都是空集，建索引纯属浪费。
    //
    // 修法：先用和第 ② 道闸门完全一致的条件过一遍，得到 candidates；
    //   · candidates 为空 → 整轮直接返回，不建索引
    //   · 非空 → 才建索引（此时索引是必需的）
    const candidates = this.entries.filter((e) => {
      if (e.reused === true) return false
      if ((e.refCount ?? 0) > 0) return false
      if (e.releasedAt === null || e.releasedAt === undefined) return false
      if (now - e.releasedAt < delayMs) return false
      return true
    })
    if (candidates.length === 0) {
      summary.scanned = this.entries.length
      summary.skipped = this.entries.length
      return summary
    }

    // ── #192：会话引用索引**整轮只建一次** ──
    //
    // 原来在循环里对每条记录调 `referencedByAnySession(digest)`，
    // 每次都要递归扫 sessions 目录 + 逐个 zstd 解压。实测单次 **2,286 ms**，
    // 526 条 → 一轮约 20 分钟，而 sweep 每 5 分钟触发一次 → **永远在跑**。
    //
    // 现在先建一次索引（约 300 ms），循环里 O(1) 查表。
    // #200 之后，只有 candidates 非空时才建（无候选就连扫都不扫）。
    let sessionRefs
    let indexMeta
    if (checkSessions) {
      try {
        const built = await this.#buildSessionRefIndex()
        sessionRefs = built.refs
        indexMeta = { files: built.files, refs: built.refs.size }
      } catch (error) {
        // 索引建不起来时**不能**默认"全部可删"——那会误删仍在引用的图。
        // 保守做法：本轮跳过所有回收，等下轮再试。
        this.#audit(`warning: 建立会话引用索引失败（${error?.message}），本轮跳过回收`)
        return { ...summary, skipped: this.entries.length, indexFailed: true }
      }

      // ── 兜底：索引为空但会话文件存在 → 可能引用格式变了 ──
      //
      // 实测当前环境：141 个会话文件里**确实没有任何** attachment/sha256 字样，
      // 那种情况下"全部无引用"是正确结论，可以放心回收。
      //
      // 但假如将来 DSH 改了引用格式（比如从 `sha256:<hex>` 变成别的写法），
      // 我们的正则就会一个都匹配不到 —— 那时"全部无引用"是**假象**，
      // 照此回收会把仍在用的图片全删掉。
      //
      // 安全策略：有会话文件、却一个引用都提取不到时，**只在 dryRun 下发日志**，
      // 不自动删除；同时在 summary 里标 `suspectIndexEmpty`，
      // 让面板/日志能看到"这里可能有格式不匹配"。
      if (indexMeta.files > 0 && indexMeta.refs === 0) {
        this.#audit(
          `notice: 扫描了 ${indexMeta.files} 个会话文件但未提取到任何附件引用。` +
          '若确认会话里确实没有图片（当前环境即是），这是正常的；' +
          '若刚发过图却被判为无引用，说明引用格式变了，请检查 #buildSessionRefIndex 的正则。',
        )
      }
    }

    for (const entry of [...this.entries]) {
      summary.scanned += 1
      // 复用本机的对象：**永不删**
      if (entry.reused === true) {
        summary.skipped += 1
        continue
      }
      // 仍在被使用
      if ((entry.refCount ?? 0) > 0) {
        summary.skipped += 1
        continue
      }
      // 未到回收时间
      if (entry.releasedAt === null || entry.releasedAt === undefined || now - entry.releasedAt < delayMs) {
        summary.skipped += 1
        continue
      }
      // ② 会话引用检查（改成查索引，O(1)）
      if (checkSessions) {
        const referenced = sessionRefs !== undefined && sessionRefs.has(String(entry.digest))
        if (referenced) {
          entry.pinned = true
          summary.skipped += 1
          summary.details.push({ digest: entry.digest, action: 'skip', reason: '本机会话仍引用' })
          this.#audit(`skip ${entry.digest.slice(0, 12)}…：本机会话仍引用（已标记 pinned）`)
          continue
        }
      }
      // ③ 内容校验
      const verified = await this.verifyDigest(entry.digest)
      if (!verified) {
        summary.skipped += 1
        summary.details.push({ digest: entry.digest, action: 'skip', reason: '对象不存在或内容校验失败' })
        this.#audit(`skip ${entry.digest.slice(0, 12)}…：对象缺失或校验失败（保守跳过）`)
        continue
      }

      if (useDryRun) {
        summary.details.push({ digest: entry.digest, action: 'would-reclaim' })
        this.#audit(`[dry-run] would reclaim ${entry.digest.slice(0, 12)}…（${entry.bytes} bytes）`)
        continue
      }

      // ④ 删除前重新确认一次（关键，缺了就是 use-after-free）
      // 上面 ② ③ 两步都是 await（扫会话目录、读整个对象算哈希），一轮能跑上百毫秒；
      // 这个窗口里另一个请求完全可能 save() 同一张图、把 refCount 从 0 加回 1，
      // 并把 releasedAt 置回 null。早先只在进循环时判一次，于是刚被重新引用的对象照样被 rm，
      // 请求手里的 sha256:… 立刻变成 ENOENT。
      const stillHot = (entry.refCount ?? 0) > 0 || entry.releasedAt === null || entry.releasedAt === undefined
      if (stillHot) {
        summary.skipped += 1
        summary.details.push({ digest: entry.digest, action: 'skip', reason: '扫描期间被重新引用' })
        this.#audit(`skip ${entry.digest.slice(0, 12)}…：扫描期间被重新引用（保守跳过）`)
        continue
      }

      try {
        await rm(objectPathOf(entry.digest))
        this.entries = this.entries.filter((e) => e !== entry)
        removedAny = true
        summary.reclaimed += 1
        summary.details.push({ digest: entry.digest, action: 'reclaimed' })
        this.#audit(`reclaimed ${entry.digest.slice(0, 12)}…（${entry.bytes} bytes）`)
      } catch (error) {
        summary.errors += 1
        summary.details.push({ digest: entry.digest, action: 'error', reason: String(error?.message ?? error) })
        this.#audit(`error reclaiming ${entry.digest.slice(0, 12)}…：${error?.message}`)
      }
    }

    if (removedAny) await this.persist()
    return summary
  }

  /** 启动定时回收（默认每 5 分钟一轮）。 */
  start() {
    const cfg = this.config()
    const interval = Number.isFinite(cfg?.attachments?.sweepIntervalMs) ? cfg.attachments.sweepIntervalMs : 5 * 60 * 1000
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        this.ctx.logger.warn(`[lantern][attachment] 回收失败：${error?.message}`)
      })
    }, interval)
    this.timer.unref?.()
    return this
  }

  /** 停止定时器。 */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 诊断快照（设置面板用）。 */
  status() {
    const cfg = this.config()
    const pending = this.entries.filter((e) => (e.refCount ?? 0) === 0 && e.releasedAt !== null)
    return {
      total: this.entries.length,
      inUse: this.entries.filter((e) => (e.refCount ?? 0) > 0).length,
      pendingReclaim: pending.length,
      pinned: this.entries.filter((e) => e.pinned === true).length,
      bytes: this.entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      dryRun: cfg?.attachments?.dryRun !== false,
      reclaimDelayMs: cfg?.attachments?.reclaimDelayMs ?? 5 * 60 * 1000,
      objectsRoot: objectsRoot(),
      recentAudit: this.audit.slice(-20),
    }
  }
}
