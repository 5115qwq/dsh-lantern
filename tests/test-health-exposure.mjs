/**
 * health 免鉴权端点的拓扑保护（BUG #31 的回归护栏）。
 *
 * 规则：全量诊断要同时满足「脱敏关了」**且**「请求来自本机」。
 * 原因：exposure 开关表达的是"管理员愿不愿意看拓扑"，表达不了"谁能看到"；
 * 而这条端点在鉴权之前、免鉴权可用。只关 maskTopology 就会把 mediaDir 绝对路径、
 * hiddenReason 里的上游错误原文、真实绑定地址与 key 数量吐给公网。
 */
import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs'

const P = `${LANTERN_DIR}/lib/index.js`
const src = fs.readFileSync(P, 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

console.log('【源码级】')
check('health 判定含本机限制', /if \(isMasked\(current\) \|\| !fromLoopback\)/.test(src))
check('识别 IPv4 回环', /remote === '127\.0\.0\.1'/.test(src))
check('识别 IPv6 回环', /remote === '::1'/.test(src))
check('识别 IPv4-mapped IPv6', /remote === '::ffff:127\.0\.0\.1'/.test(src))
check('识别 IPv4-mapped 网段', /remote\.startsWith\('::ffff:127\.'\)/.test(src))
check('remoteAddress 取自 socket（不可被 header 伪造）', /req\.socket\?\.remoteAddress/.test(src))
check('没有取 X-Forwarded-For（可伪造）', !/x-forwarded-for/i.test(src.slice(src.indexOf('fromLoopback') - 3000, src.indexOf('fromLoopback') + 500)))

console.log('\n【行为级：抽取判定逻辑跑真值表】')
const m = /const remote = String\(req\.socket\?\.remoteAddress \?\? ''\)\n\s+const fromLoopback = ([\s\S]*?)\n\s+if \(isMasked/.exec(src)
check('能抽出 fromLoopback 表达式', m !== null)
if (m !== null) {
  const expr = m[1].trim().replace(/;\s*$/, '')
  const fn = new Function('remote', 'return ' + expr)
  const table = [
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:127.0.0.5', true],
    ['192.168.1.5', false],
    ['10.0.0.1', false],
    ['::ffff:192.168.1.5', false],
    ['203.0.113.7', false],
    ['', false],
    ['127.0.0.10.5', false],
  ]
  for (const [addr, want] of table) {
    let got
    try { got = fn(addr) === true } catch (e) { got = 'throw:' + e.message }
    check('remote=' + (addr || '(空)') + ' → ' + want, got === want, 'got ' + got)
  }
}

console.log('\n【结构一致性：health 分支仍有全量 payload】')
// #194：媒体功能（生图/生视频）已整体下线，health 里不再有 media 字段。
// 这条断言改成"确认它已被移除"，防止未来有人误把媒体功能加回来却忘了打通链路。
check('media 描述已移除（媒体功能下线）', !/media: mediaGateway\.describe\(\)/.test(src))
check('仍保留 directory 诊断', /directory: directory\.diagnostics\(\)/.test(src))
check('简单模式仍只回三项', /sendJson\(res, 200, \{ ok: true, plugin: name, enabled: current\.enabled \}\)/.test(src))

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
