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
 *   data/keys.json                局域网访问 key（sha256 + 本机信任边界内的明文，供面板「查看」）
 *   data/capabilities.json        能力缓存/覆盖/测试结果
 *   data/usage.jsonl              用量账本（追加式 JSONL）
 *   data/usage-archive-<year>.jsonl 归档
 *   data/reports/usage-<ts>.html  用量报告
 *   data/logs/*.log               运行日志
 *   data/tmp/                     运行期临时文件
 *
 * @module dsh-lantern/storage
 */
import { mkdir, readFile, rename, rm, writeFile, readdir, stat, unlink, cp, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

/** 插件包根目录（本文件位于 <root>/lib/storage.js）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 插件自有数据目录 —— 本插件**唯一**的写入位置。
 *
 * ⚠ **必须放在包目录之外。**
 *
 * 早期实现是 `join(PACKAGE_ROOT, 'data')`，即数据直接放在插件包里面。
 * 那个位置有个致命问题：**插件以包的形式安装时，包管理器（pnpm add）
 * 会整体替换包目录** —— 只要 DSH 重启时重新安装了一次插件
 * （例如 profile 的 dependencies 里记的是 `github:owner/repo`，
 * 每次启动都可能重新拉取），`data/` 就会连同 keys.json、usage.jsonl、
 * capabilities.json 一起被清空。
 *
 * 真实事故：一次 DSH 重启触发了重装，3 个 API Key、全部用量账本、
 * 自定义模型配置、能力学习缓存全部丢失，且 config.json 被重置为默认值
 * （`enabled: false` —— 网关静默停止服务）。
 *
 * 因此改为**包外的固定位置**，与 DSH 的 `.dsh` 同级：
 *
 *   ~/.dsh/lantern-data/          ← 默认
 *
 * 该位置的好处：
 * 1. 重装/升级插件不会动它；
 * 2. 多个 profile 共享同一份 Key 与用量（同一台机器上没必要各存一份）；
 * 3. 备份时位置固定、好描述。
 *
 * 覆盖方式（测试或特殊部署用）：环境变量 `LANTERN_DATA_DIR`。
 *
 * 迁移：若包目录内仍存在旧的 `data/` 且外部目录为空，首次启动会自动
 * 复制过去（保留旧目录不删，作为回退）。
 */
export const DATA_DIR = (() => {
  const override = process.env.LANTERN_DATA_DIR
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.dsh', 'lantern-data')
})()

/** 旧版数据目录（包内）。仅用于一次性迁移。 */
export const LEGACY_DATA_DIR = join(PACKAGE_ROOT, 'data')

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
// ⚠ 不含 `PATHS.logs`：本插件从不往 `logs/` 写任何文件（日志走 DSH 的 logger），
// 早先把它放进这里只是建了个永远为空的目录。空目录本身无害，但会让人误以为
// 那里有日志可看 —— 去掉，避免误导。（`PATHS.logs` 常量保留，将来真要用时可直接用。）
const REQUIRED_DIRS = [DATA_DIR, PATHS.tmp, PATHS.reports]

/**
 * 清理过期的「损坏文件隔离副本」。
 *
 * ## 为什么需要
 *
 * `readJson` 遇到损坏文件时把它改名成 `<file>.corrupt-<ts>` 留存，
 * 避免「损坏 → 兜底成空 → 用户新建时整份覆盖 → 原数据永久消失」。
 * 这个机制必须保留 —— 它是数据丢失事故的现场证据。
 *
 * 但**留存副本会累积**：反复损坏（磁盘故障、进程被杀、并发写冲突）会把
 * 同一份文件堆出几十个 `.corrupt-*`，每个都是完整文件大小。
 *
 * 所以按数量保留最近 `keep` 个（默认 5），更早的删除。
 * 保留多个是刻意的：一次损坏可能同时产生多份（不同文件），只留 1 个会挤掉别的现场。
 *
 * @param keep - 保留最近几个（默认 5）。
 * @returns 删除了几个。
 */
export async function sweepCorruptions(keep = 5) {
  let removed = 0
  try {
    const entries = await readdir(DATA_DIR)
    const corrupt = []
    for (const name of entries) {
      const m = /\.corrupt-(\d+)$/.exec(name)
      if (m === null) continue
      corrupt.push({ name, ts: Number(m[1]) })
    }
    if (corrupt.length <= keep) return 0
    corrupt.sort((a, b) => a.ts - b.ts)
    for (const item of corrupt.slice(0, corrupt.length - keep)) {
      try {
        await unlink(join(DATA_DIR, item.name))
        removed += 1
      } catch {
        /* 单个失败不影响其它 */
      }
    }
  } catch {
    /* 目录不可读时忽略 —— 清理失败不该阻塞启动 */
  }
  return removed
}

/**
 * 统计账本归档文件（`usage-archive-*.jsonl`）。
 *
 * **不自动删除** —— 那是用户的历史用量数据，删了就是丢历史。
 * 但必须在界面上可见，否则用户永远不知道磁盘被它们占了多少。
 *
 * @returns `{ count, bytes, oldest, newest }`
 */
export async function archiveStats() {
  const out = { count: 0, bytes: 0, oldest: null, newest: null }
  try {
    const entries = await readdir(DATA_DIR)
    const st = []
    for (const name of entries) {
      if (!/^usage-archive-/.test(name)) continue
      try {
        const info = await stat(join(DATA_DIR, name))
        st.push({ name, mtime: info.mtimeMs, size: info.size })
      } catch {
        /* 单个读不到就跳过 */
      }
    }
    st.sort((a, b) => a.mtime - b.mtime)
    out.count = st.length
    out.bytes = st.reduce((a, x) => a + x.size, 0)
    out.oldest = st[0]?.name ?? null
    out.newest = st[st.length - 1]?.name ?? null
  } catch {
    /* 忽略 */
  }
  return out
}

/** 隔离副本清理记录（供启动日志汇报）。 */
export const CORRUPTION_SWEEP_LOG = []

/**
 * 把包内旧 `data/` 里的文件一次性迁移到外部数据目录。
 *
 * 只在**外部目录还没有同名文件**时复制，绝不覆盖已有数据。
 * 旧目录保留不动（用户可自行确认后删除）。
 *
 * @returns 迁移的文件名列表（空数组 = 无需迁移）。
 */
export async function migrateLegacyData() {
  const moved = []
  if (DATA_DIR === LEGACY_DATA_DIR) return moved
  if (!existsSync(LEGACY_DATA_DIR)) return moved
  let entries
  try {
    entries = await readdir(LEGACY_DATA_DIR, { withFileTypes: true })
  } catch {
    return moved
  }
  await mkdir(DATA_DIR, { recursive: true })
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const from = join(LEGACY_DATA_DIR, ent.name)
    const to = join(DATA_DIR, ent.name)
    // 外部已有同名文件 → 不动（外部优先）
    try {
      await access(to)
      continue
    } catch {
      /* 目标不存在，可以复制 */
    }
    try {
      await cp(from, to)
      moved.push(ent.name)
    } catch {
      /* 单个文件失败不影响其他文件 */
    }
  }
  return moved
}

/**
 * 建好插件自有的目录树，并尝试迁移旧数据。
 * @returns 数据目录的绝对路径。
 */
export async function ensureDirs() {
  for (const dir of REQUIRED_DIRS) await mkdir(dir, { recursive: true })
  // 迁移只做一次：外部目录已存在关键文件时 migrateLegacyData 会跳过
  try {
    const moved = await migrateLegacyData()
    if (moved.length > 0) {
      LEGACY_MIGRATION_LOG.push(...moved)
    }
  } catch {
    /* 迁移失败不阻塞启动 */
  }
  // 清理累积的损坏隔离副本（保留最近 5 个 —— 见 sweepCorruptions 的说明）
  try {
    const swept = await sweepCorruptions(5)
    if (swept > 0) CORRUPTION_SWEEP_LOG.push(swept)
  } catch {
    /* 清理失败不阻塞启动 */
  }
  return DATA_DIR
}

/** 迁移记录（供启动日志汇报）。 */
export const LEGACY_MIGRATION_LOG = []

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
