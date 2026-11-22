import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from "node:fs"
const P = `${LANTERN_DIR}`
const { detectNegativeCapability } = await import("file:///" + P + "/lib/capabilities.js")
const src = readFileSync(P + "/lib/index.js", "utf8")
const s = src.indexOf("const OPTION_FIELD_PATTERN")
const e = src.indexOf("/**\n * 判断一次失败值不值得")
const strip = new Function(src.slice(s, e) + "\nreturn stripUnsupportedOption")()

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) pass += 1; else { fail += 1; console.log("  ✗ " + n + (x ? " — " + x : "")) } }
const section = (n) => console.log("\n── " + n + " ──")

section("D1 adapter 拒收 GenerateOptions 字段能被认出来")
const d = detectNegativeCapability
ok("pi-ai stop 原文 → stop", d('llm-pi-ai does not support GenerateOptions.stop') === 'stop')
ok("doesn't 缩写", d("llm-x doesn't support GenerateOptions.temperature") === 'temperature')
ok("reasoningEffort → reasoning", d("a does not support GenerateOptions.reasoningEffort") === 'reasoning')
ok("tools → tools", d("x does not support GenerateOptions.tools") === 'tools')
ok("未知字段不乱学", d("x does not support GenerateOptions.maxTokens") === undefined)
ok("老正则仍生效（stop sequences）", d("stop sequences are not supported by this model") === 'stop')
ok("老正则仍生效（temperature）", d("temperature is not supported") === 'temperature')
ok("无关文本 → undefined", d("connection reset by peer") === undefined)
ok("空串 → undefined", d("") === undefined)
ok("句号跨越不误命中", d("stop sequence is too long. this model does not support tools") === 'tools')

section("D2 摘字段重试只摘认得的那一个")
const msg = 'llm-pi-ai does not support GenerateOptions.stop'
const opts = { provider: "p", model: "m", stop: ["\n\n"], temperature: 0.7 }
const seen = new Set()
const r1 = strip(opts, msg, seen)
ok("摘掉 stop 保留其余", r1 !== undefined && r1.field === 'stop' && !('stop' in r1.next) && r1.next.temperature === 0.7)
ok("原对象不被改动", 'stop' in opts)
ok("同字段不无限摘", strip(r1.next, msg, seen) === undefined)
ok("未知字段不动", strip(opts, "x does not support GenerateOptions.maxTokens", new Set()) === undefined)
ok("无关错误不动", strip(opts, "connection reset", new Set()) === undefined)
ok("message=undefined 安全", strip(opts, undefined, new Set()) === undefined)
ok("options=undefined 安全", strip(undefined, msg, new Set()) === undefined)
ok("字段不在 options 里时不动", strip({ temperature: 1 }, msg, new Set()) === undefined)

section("D3 两个执行器都接线了，且顺序正确")
ok("流式路径有接线", /if \(!committed && baseOptions\.signal\?\.aborted !== true\) \{\s*\n\s*const stripped = stripUnsupportedOption/.test(src))
ok("非流式路径有接线", /\n    if \(baseOptions\.signal\?\.aborted !== true\) \{\s*\n\s*const stripped = stripUnsupportedOption/.test(src))
// #153 之后 cooldownMs 那一行变成了带 skipCooldown 的版本，断言跟着更新。
  ok("摘字段在记健康账之前", src.indexOf("const stripped = stripUnsupportedOption") < src.indexOf("deps.backendHealth?.recordFailure(plan, failure"))
ok("摘字段不花重试预算", !/if \(stripped !== undefined\) \{[^}]*budget -= 1/.test(src))
ok("记录里标了 strippedOption", (src.match(/attempt\.strippedOption = stripped\.field/g) ?? []).length === 2)

console.log("\n==== " + pass + " passed, " + fail + " failed ====")
if (fail > 0) process.exit(1)
