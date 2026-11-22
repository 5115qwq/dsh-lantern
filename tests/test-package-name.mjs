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
import { readFileSync } from 'node:fs'
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
  const profilePkg = 'C:/Users/才疏学浅/.dsh/profiles/desktop/package.json'
  try {
    const p = JSON.parse(readFileSync(profilePkg, 'utf8'))
    const deps = Object.keys(p.dependencies ?? {}).filter((k) => /lantern/i.test(k))
    const bundles = (p.dsh?.profile?.bundles ?? []).filter((b) => /lantern/i.test(b))
    console.log(`      dependencies: ${deps.join(', ') || '(无)'}`)
    console.log(`      bundles: ${bundles.join(', ') || '(无)'}`)
    if (deps.length > 0) {
      t('dependencies 里的包名与 package.json 一致', deps.every((d) => d === NAME), { deps, NAME })
    } else {
      console.log('      · 未在 profile 中安装，跳过')
    }
    if (bundles.length > 0) {
      t('bundles 里的包名与 package.json 一致', bundles.every((b) => b === NAME), { bundles, NAME })
    }
  } catch {
    console.log('      · 读不到 profile，跳过')
  }
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0