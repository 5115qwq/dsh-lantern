/**
 * dsh-lantern — 本地存储层（Host 半部内部模块）。
 *
 * 隔离纪律（设计方案 §7.6，用户明确要求）：
 * 1. **唯一写入位置**是本插件自己的 `<插件根>/data/`；
 * 2. **不写** settings.yaml（故不使用 ctx.settings.installSection）、
 *    不写 sessions/ storages/ .credentials.yaml、不碰 npm 安装树；
 * 3. 运行期临时文件也放 `data/tmp/`，**不使用 os.tmpdir()**；
 * 4. 写入一律 tmp + rename 原子替换，避免半截文件。
 *
 * 目录布局：
 *   data/config.json              全局配置（开关/限额/端口/过滤…）
 *   data/keys.json                局域网访问 key（只存 sha256，绝无明文）
 *   data/capabilities.json        能力缓存/覆盖/测试结果
 *   data/usage.jsonl              用量账本（追加式 JSONL）
 *   data/usage-archive-<year>.jsonl 归档
 *   data/reports/usage-<ts>.html  用量报告
 *   data/logs/*.log               运行日志
 *   data/tmp/                     运行期临时文件
 *
 * @module dsh-lantern/storage
 */
import { mkdir, readFile, rename, rm, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件位于 <root>/lib/storage.js）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 插件自有数据目录——本插件**唯一**的写入位置。 */
export const DATA_DIR = join(PACKAGE_ROOT, 'data')

export const PATHS = Object.freeze({
  data: DATA_DIR,
  tmp: join(DATA_DIR, 'tmp'),
  logs: join(DATA_DIR, 'logs'),
  reports: join(DATA_DIR, 'reports'),
  config: join(DATA_DIR, 'config.json'),
  keys: join(DATA_DIR, 'keys.json'),
  capabilities: join(DATA_DIR, 'capabilities.json'),
  usage: join(DATA_DIR, 'usage.jsonl'),
  attachmentLedger: join(DATA_DIR, 'attachment-ledger.json'),
  diagnostics: join(DATA_DIR, 'diagnostics.json'),
})

/** 所有需要预先存在的目录（启动时一次性建好）。 */
const REQUIRED_DIRS = [DATA_DIR, PATHS.tmp, PATHS.logs, PATHS.reports]

/**
 * 建好插件自有的目录树。
 * 只创建目录，不写任何外部路径。
 * @returns 数据目录的绝对路径。
 */
export async function ensureDirs() {
  for (const dir of REQUIRED_DIRS) await mkdir(dir, { recursive: true })
  return DATA_DIR
}

/**
 * 最近发生过"文件损坏被隔离"的记录（最多 32 条，进程级）。
 *
 * 为什么要留这个：读失败被静默兜底是很多数据丢失事故的第一现场。
 * 典型链条——`keys.json` 被截断 → `readJson` 返回 `{keys: []}` →
 * `KeyStore` 认为"从未配置过" → 用户新建一个 key 时整份覆盖 →
 * 原来那 3 个 key 永久消失，而且**日志里一个字都没有**。
 * 现在损坏文件会被改名成 `.corrupt-<ts>` 留存，并把现场记进这个数组，
 * 插件启动时读它打警告，用户才有机会发现"我的 key 怎么全没了"。
 *
 * @type {Array<{file: string, at: string, reason: string, movedTo?: string}>}
 */
export const corruptions = []

/** 记一条损坏现场（内部用）。 */
function noteCorruption(file, reason, movedTo) {
  corruptions.push({ file, at: new Date().toISOString(), reason, ...(movedTo === undefined ? {} : { movedTo }) })
  if (corruptions.length > 32) corruptions.splice(0, corruptions.length - 32)
}

/**
 * 取走（并清空）累积的损坏记录，供启动流程统一告警。
 * @returns 损坏记录数组（可能为空）。
 */
export function drainCorruptions() {
  if (corruptions.length === 0) return []
  const taken = corruptions.slice()
  corruptions.length = 0
  return taken
}

/**
 * 把损坏的文件改名留存，**绝不在原地覆盖**。
 *
 * 为什么改名而不是删除/忽略：文件里可能是用户唯一的那份配置或 key 列表，
 * 直接从内存兜底值继续跑，等于用"默认值"覆盖掉"唯一副本"。
 * 改名之后：① 原件还在，能手改回来；② 目标路径空了，后续写入不会覆盖证据。
 *
 * @param file - 目标绝对路径。
 * @param reason - 失败原因（进日志/面板）。
 * @returns 改名后的路径；改名失败时 undefined。
 */
async function quarantine(file, reason) {
  const movedTo = `${file}.corrupt-${Date.now()}`
  try {
    await rename(file, movedTo)
    noteCorruption(file, reason, movedTo)
    return movedTo
  } catch {
    noteCorruption(file, reason, undefined)
    return undefined
  }
}

/**
 * 读一个 JSON 文件；**不存在**返回兜底值，**损坏**则隔离原件后返回兜底值。
 *
 * 两者的区别是本函数的全部意义：
 * - `ENOENT`（第一次运行）→ 就该用兜底值，调用方随后会写出初始文件；
 * - 解析失败/读失败（磁盘坏了、进程被强杀写了半截、手工编辑打错一个括号）
 *   → 兜底值只是"让插件能起来"，**绝不能当成"用户没配过"**。
 *   所以这里把损坏文件改名成 `.corrupt-<ts>` 留证，并记进 {@link corruptions}。
 *
 * 不抛错是刻意的：单个数据文件坏掉不该让整个插件加载失败。
 *
 * @param file - 绝对路径。
 * @param fallback - 不存在或损坏时的返回值。
 * @returns 解析后的对象，或兜底值。
 */
export async function readJson(file, fallback = undefined) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') await quarantine(file, `读取失败：${err?.code ?? err?.message ?? 'unknown'}`)
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    await quarantine(file, `JSON 解析失败：${err?.message ?? 'unknown'}`)
    return fallback
  }
}

/**
 * 原子写一个 JSON 文件（tmp + rename），并确保父目录存在。
 * 全程只落在插件自己的 data/ 内。
 *
 * 临时文件放在 `data/tmp/`（而不是目标文件旁边）：
 * 这样即使进程被强杀留下半截文件，也会被启动时的 `sweepTmp()` 清掉，
 * 不会污染 `data/` 根目录（本机实测踩过：强杀后残留 `*.tmp-<pid>-<ts>`）。
 *
 * @param file - 目标绝对路径。
 * @param value - 可 JSON 序列化的值。
 */
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await mkdir(PATHS.tmp, { recursive: true })
  const tmp = join(PATHS.tmp, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 追加一行 JSONL（用量账本用）。
 * @param file - 目标绝对路径。
 * @param record - 一行记录。
 */
export async function appendJsonl(file, record) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
}

/**
 * 流式逐行读 JSONL，边读边归约——账本可能很大，避免一次性载入内存。
 * 单行解析失败只跳过该行，不中断整轮。
 * @param file - 目标绝对路径。
 * @param onRecord - 每行的回调（同步）。
 * @returns 成功解析的行数。
 */
export async function readJsonlStreaming(file, onRecord) {
  let handle
  try {
    const { open } = await import('node:fs/promises')
    handle = await open(file, 'r')
  } catch {
    return 0
  }
  let count = 0
  let carry = ''
  try {
    const stream = handle.createReadStream({ encoding: 'utf8' })
    for await (const chunk of stream) {
      carry += chunk
      let index = carry.indexOf('\n')
      while (index >= 0) {
        const line = carry.slice(0, index).trim()
        carry = carry.slice(index + 1)
        if (line.length > 0) {
          try {
            onRecord(JSON.parse(line))
            count += 1
          } catch {
            /* 跳过损坏行 */
          }
        }
        index = carry.indexOf('\n')
      }
    }
    const tail = carry.trim()
    if (tail.length > 0) {
      try {
        onRecord(JSON.parse(tail))
        count += 1
      } catch {
        /* 跳过损坏行 */
      }
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return count
}

/**
 * 启动时清理 data/tmp/ 里的残留临时文件（进程崩溃遗留）。
 * 只清插件自己的临时目录。
 *
 * ── #190：也要清**子目录** ──
 * 原来只处理 `info.isFile()`，子目录被无条件跳过。
 * 实测 `data/tmp/lib-bak-archive-20261103/` 里积了 37 个文件 / 2.57 MB，
 * 全部是几个月前的手工备份，每次启动都「看见但不删」，永久占盘。
 * 现在：子目录也按 mtime 判龄，整棵删掉。
 *
 * @param maxAgeMs - 超过该年龄的文件才删（默认 1 小时，避免误删正在写的）。
 * @returns 清理掉的条目数（文件 + 子目录）。
 */
export async function sweepTmp(maxAgeMs = 3600_000) {
  let removed = 0
  try {
    const entries = await readdir(PATHS.tmp)
    const now = Date.now()
    for (const entry of entries) {
      const full = join(PATHS.tmp, entry)
      try {
        const info = await stat(full)
        if (now - info.mtimeMs <= maxAgeMs) continue
        if (info.isFile()) {
          await unlink(full)
          removed += 1
        } else if (info.isDirectory()) {
          // 子目录整棵删。rm 的 recursive 在 Node 14.14+ 可用。
          await rm(full, { recursive: true, force: true })
          removed += 1
        }
      } catch {
        /* 单个条目失败不影响其它 */
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
  return removed
}
