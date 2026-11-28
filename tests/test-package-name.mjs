// #241：包名一致性守卫
//
// ## 背景（真实事故，连踩两次）
//
// 把包名从 `dsh-lantern` 改成 `@5115qwq/dsh-lantern` 时：
//
//   ① 漏改 cordis.patch.yml 的 name
//      → DSH 拿旧名去 import，报 ERR_MODULE_NOT_FOUND，插件无法启用
//
//   ② 漏改 client.js 里 __ModuleLoader__.load 的 id
//      → 客户端模块加载了但注册键对不上，报
//        "loaded without registering ... via __ModuleLoader__.load"
//
// ## DSH 的两条装配链路（机制不同，要求也不同）
//
//   服务端：cordis.patch.yml 的 `name` 决定 import 哪个包
//           → 必须等于 package.json 的 name
//
//   客户端：DSH 扫包生成 manifest，用包名做 row.id；
//           浏览器端 __ModuleLoader__.load({ id }) 用这个 id 注册到 factories
//           → id 必须等于 package.json 的 name
//           （见 DSH 源码 register(): stripClientSuffix(registration.id) 作为 key，
//              arrive(): if (this.factories.has(row.id)) 查同一个 key）
//
// 本测试守的就是这两处。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LANTERN_DIR } from './paths.mjs'

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ 包名一致性守卫（#241）════════')
console.log('')

const pkg = JSON.parse(readFileSync(`${LANTERN_DIR}/package.json`, 'utf8'))
const NAME = pkg.name
console.log(`  package.json name: ${NAME}`)
console.log('')

// ── 1. cordis.patch.yml 的装配名 ──
console.log('【1】cordis.patch.yml（服务端装配）')
{
  const yml = readFileSync(`${LANTERN_DIR}/cordis.patch.yml`, 'utf8')
  const m = /^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(yml)
  const name = m?.[1]?.trim()
  console.log(`      name: ${name}`)
  t('name 存在', typeof name === 'string' && name.length > 0, name)
  t('name 等于 package.json name', name === NAME, { yml: name, pkg: NAME })
}

// ── 2. client.js 的 __ModuleLoader__ 注册 id ──
console.log('')
console.log('【2】lib/client.js（客户端注册）')
{
  const s = readFileSync(`${LANTERN_DIR}/lib/client.js`, 'utf8')
  const lines = s.split('\n')

  // 第一行必须调用 __ModuleLoader__.load
  t('首行调用 __ModuleLoader__.load', /__ModuleLoader__\.load\(\{/.test(lines[0] ?? ''), (lines[0] ?? '').slice(0, 60))

  // 取 id 字段
  const m = /id:\s*['"]([^'"]+)['"]/.exec(s.slice(0, 500))
  const id = m?.[1]
  console.log(`      id: ${id}`)
  t('id 存在', typeof id === 'string' && id.length > 0, id)
  t('id 等于 package.json name', id === NAME, { clientId: id, pkg: NAME })

  // 不能有旧的裸名（排除 @scope/xxx 里的部分）
  const bareOld = /id:\s*['"]dsh-lantern['"]/.test(s)
  t('没有残留旧 id（dsh-lantern）', !bareOld)
}

// ── 3. profile 装配一致性（如果读得到）──
console.log('')
console.log('【3】profile 配置（可选）')
{
  // 不写死作者本机的绝对路径：优先用环境变量指定，否则按当前用户目录
  // 自动找「确实装了本包」的 profile；两者都取不到时明确跳过，不静默忽略。
  const envPath = process.env.LANTERN_PROFILE_PKG
  let profilePkg
  let skipReason = ''
  if (typeof envPath === 'string' && envPath.length > 0) {
    if (existsSync(envPath)) profilePkg = envPath
    else skipReason = `LANTERN_PROFILE_PKG 指向的文件不存在：${envPath}`
  } else {
    const profilesRoot = join(homedir(), '.dsh', 'profiles')
    try {
      if (existsSync(profilesRoot)) {
        for (const d of readdirSync(profilesRoot, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const candidate = join(profilesRoot, d.name, 'package.json')
          if (!existsSync(candidate)) continue
          const j = JSON.parse(readFileSync(candidate, 'utf8'))
          if (Object.keys(j.dependencies ?? {}).includes(NAME)) { profilePkg = candidate; break }
        }
      }
    } catch (e) {
      skipReason = `扫描 profile 目录失败：${String(e.message).slice(0, 100)}`
    }
  }

  if (profilePkg === undefined) {
    console.log('      · 跳过（非本机 profile）：' + (skipReason || '未发现装有本包的 profile，可用 LANTERN_PROFILE_PKG 指定'))
  } else {
    let p
    try {
      p = JSON.parse(readFileSync(profilePkg, 'utf8'))
    } catch (e) {
      // 解析/读取失败要明确记为失败，不静默吞掉。
      t('profile package.json 可解析', false, String(e.message).slice(0, 120))
    }
    if (p !== undefined) {
      const deps = Object.keys(p.dependencies ?? {}).filter((k) => /lantern/i.test(k))
      const bundles = (p.dsh?.profile?.bundles ?? []).filter((b) => /lantern/i.test(b))
      console.log(`      profile: ${profilePkg}`)
      console.log(`      dependencies: ${deps.join(', ') || '(无)'}`)
      console.log(`      bundles: ${bundles.join(', ') || '(无)'}`)
      if (deps.length > 0) {
        t('dependencies 里的包名与 package.json 一致', deps.every((d) => d === NAME), { deps, NAME })
      } else {
        console.log('      · 未在 profile 中安装，跳过')
      }
      if (bundles.length > 0) {
        t('bundles 里的包名与 package.json 一致', bundles.every((b) => b === NAME), { bundles, NAME })
      } else {
        console.log('      · bundles 中无 lantern，跳过')
      }
    }
  }
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0