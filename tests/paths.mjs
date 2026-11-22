/**
 * 测试用的路径解析。
 *
 * 这些测试原本写死了作者本机的绝对路径（`C:/Users/.../dsh-lantern/lib`），
 * 别人克隆后跑不了。现在统一从这里取，两种方式覆盖：
 *   1. 环境变量 `LANTERN_DIR` 指向插件的**安装目录**（含 lib/ 的那一层）
 *   2. 都没设时，按"测试脚本在 <插件>/tests/ 下"推断
 *
 * 用法：
 *   LANTERN_DIR=/path/to/dsh-lantern node .regress.mjs
 *   # 或者把 tests/ 放在插件目录里，直接 node tests/.regress.mjs
 */
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

/** 插件根目录（含 lib/、data/、package.json）。 */
export const LANTERN_DIR = (() => {
  const fromEnv = process.env.LANTERN_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv.replace(/[\\/]+$/, '')
  // tests/ 的上一级
  const parent = here.replace(/[\\/]tests$/, '')
  if (existsSync(`${parent}/lib/index.js`)) return parent
  // 兜底：当前工作目录
  return process.cwd()
})()

/** lib 目录。 */
export const LANTERN_LIB = `${LANTERN_DIR}/lib`

/** data 目录。 */
export const LANTERN_DATA = `${LANTERN_DIR}/data`

/** 跑测试用的 node 可执行文件（默认就是当前这个）。 */
export const NODE = process.execPath
