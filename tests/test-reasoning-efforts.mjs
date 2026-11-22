import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs'
const P = `${LANTERN_DIR}/lib/`
const idx = fs.readFileSync(P + 'index.js', 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

// 抽出真实源码里的 mergeReasoningCell
const lines = idx.split('\n')
const start = lines.findIndex((l) => l.includes('function mergeReasoningCell('))
let depth = 0, end = start
for (let i = start; i < lines.length; i += 1) {
  for (const ch of lines[i]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1 }
  if (depth === 0 && i > start) { end = i; break }
}
const src = lines.slice(start, end + 1).join('\n')
ok('R0 抽到 mergeReasoningCell 源码', start > 0 && src.includes('effortsDiffers'))
const mergeReasoningCell = new Function(src + '\nreturn mergeReasoningCell')()

console.log('\n=== R1 无声明 → 原样返回 ===')
const picked = { value: 'supported', source: 'union' }
ok('R1a 全无 efforts 时返回同一个对象', mergeReasoningCell([{}, {}], picked) === picked)
ok('R1b undefined view 不炸', mergeReasoningCell([undefined, null], picked) === picked)

console.log('\n=== R2 并集（不是交集） ===')
const a = { reasoning: { efforts: ['low', 'high', 'max'] } }
const b = { reasoning: { efforts: ['low', 'high', 'xhigh'] } }
const r2 = mergeReasoningCell([a, b], picked)
ok('R2a efforts 是并集', JSON.stringify(r2.efforts) === JSON.stringify(['low', 'high', 'max', 'xhigh']), JSON.stringify(r2.efforts))
ok('R2b 保留调用方传入的三态', r2.value === 'supported' && r2.source === 'union')
ok('R2c 不一致时标记 differs', r2.effortsDiffers === true)

console.log('\n=== R3 一致时不标 differs ===')
const r3 = mergeReasoningCell([{ reasoning: { efforts: ['low', 'high'] } }, { reasoning: { efforts: ['low', 'high'] } }], picked)
ok('R3a 并集正确', JSON.stringify(r3.efforts) === JSON.stringify(['low', 'high']))
ok('R3b 不标 differs', r3.effortsDiffers === false)

console.log('\n=== R4 defaultEffort 必须在并集里 ===')
const r4a = mergeReasoningCell([{ reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } }], picked)
ok('R4a 合法默认值保留', r4a.defaultEffort === 'high')
const r4b = mergeReasoningCell([{ reasoning: { efforts: ['low'], defaultEffort: 'ultra' } }], picked)
ok('R4b 非法默认值丢弃', r4b.defaultEffort === undefined)

console.log('\n=== R5 顺序稳定（首次出现优先） ===')
const r5 = mergeReasoningCell([{ reasoning: { efforts: ['z', 'a'] } }, { reasoning: { efforts: ['a', 'm'] } }], picked)
ok('R5a 保持首次出现顺序', JSON.stringify(r5.efforts) === JSON.stringify(['z', 'a', 'm']), JSON.stringify(r5.efforts))

console.log('\n=== R6 非字符串项被过滤 ===')
const r6 = mergeReasoningCell([{ reasoning: { efforts: ['low', 42, null, 'high'] } }], picked)
ok('R6a 只留字符串', JSON.stringify(r6.efforts) === JSON.stringify(['low', 'high']), JSON.stringify(r6.efforts))
ok('R6b 全非法时按"无声明"处理', mergeReasoningCell([{ reasoning: { efforts: [1, 2] } }], picked) === picked)

console.log('\n=== R7 接线（源码级） ===')
ok('R7a intersectCapabilityViews 调用了 mergeReasoningCell', /merged\.reasoning = mergeReasoningCell\(usable, merged\.reasoning\)/.test(idx))
ok('R7b synthetic 分支也重算并集', /capsView\.reasoning = mergeReasoningCell\(rows\.map/.test(idx))
ok('R7c synthetic 保留附字段（不覆盖成 {value,source}）', /\{ \.\.\.\(capsOf\(rows\[0\]\?\.view\)\[field\] \?\? \{\}\), value, source: 'chain' \}/.test(idx))

console.log('\n=== R8 按档位值筛链 ===')
ok('R8a 读取 request.reasoningEffort', idx.includes('const wantEffort = typeof request.reasoningEffort'))
ok('R8b preferred 要求档位 supported', /hardNeed\.every\(\(field\) => supportedIn\(row, field\)\) && effortState\(row\) === 'supported'/.test(idx))
ok('R8c excluded 含档位 unsupported', /effortState\(row\) === 'unsupported' && !preferred\.includes\(row\)/.test(idx))
ok('R8d 列表空视为 unknown（不剥夺资格）', /if \(list\.length === 0\) return 'unknown'/.test(idx))
ok('R8e 大小写不敏感', /toLowerCase\(\) === wantEffort\.toLowerCase\(\)/.test(idx))

console.log('\n=== R9 三通道都传了档位值 ===')
const chatCall = idx.slice(idx.indexOf("case is chat"), 0)
ok('R9a chat 传 reasoningEffort', /reasoningEffort: typeof body\.reasoning_effort === 'string'/.test(idx))
ok('R9b responses 传 reasoningEffort', /reasoningEffort: typeof parsed\.reasoningEffort === 'string'/.test(idx))
ok('R9c anthropic disabled → off', /body\.thinking\.type === 'disabled'\s*\n\s*\? 'off'/.test(idx))

console.log('\n=== R10 前端改名 ===')
const cli = fs.readFileSync(P + 'client.js', 'utf8')
ok('R10a 有 editName state', cli.includes('const [editName, setEditName] = React.useState'))
ok('R10b 有 editDisplay state', cli.includes('const [editDisplay, setEditDisplay] = React.useState'))
ok('R10c 展开时回填模型名', /setEditName\(m\.name\)/.test(cli))
ok('R10d 展开时回填显示名', /setEditDisplay\(m\.display \?\? ''\)/.test(cli))
ok('R10e 清空不提交（不撞长度校验）', /nextName\.length > 0 && nextName !== m\.name \? \{ name: nextName \} : \{\}/.test(cli))
ok('R10f 改名后才发 name', /\.\.\.namePatch,/.test(cli))
ok('R10g 成功文案区分改名', cli.includes('已改名（客户端记得同步改 model 字段）'))
ok('R10h 说明里点出 @ 不能用', cli.includes('不能带 @'))
ok('R10i display 始终发（可清空）', /display: displayPatch,/.test(cli) && /const nextDisplay = editDisplay\.trim\(\)/.test(cli))
// R10j：改名时显示名默认跟着走 —— 只判「还停在旧模型名上」这一种情形，
// 用户自己起过的显示名必须原样保留（服务端也是这个语义，单测 M2 钉死）。
ok('R10j 改名时显示名默认跟随（仅当仍是旧模型名）', /const displayPatch = namePatch\.name !== undefined && nextDisplay === m\.name/.test(cli))
// R10k：`namePatch` 必须在 `run()` **外面**的箭头函数体里声明。
// 曾经的写法是 `onClick: () => run(async () => { const namePatch = ... }, namePatch.name === undefined ? ...)`，
// 第二个实参在 `run(...)` 的调用层求值，读不到回调体里的 `namePatch` →
// 点保存只抛 `ReferenceError: namePatch is not defined`，按钮看得见、点得动、什么都不发生。
// 这类"作用域写错"单测抓不到、只有真机点一下才暴露，所以用源码形状钉死。
ok('R10k namePatch 声明在 run() 之外（否则保存按钮静默失效）', /onClick: \(\) => \{\n[\s\S]{0,1200}?const namePatch = [\s\S]{0,900}?void run\(async \(\) => \{/.test(cli))
ok('R10k2 onClick 不再是 run(async ...) 直接包裹', !/onClick: \(\) => run\(async \(\) => \{\s*\n\s*\/\/ 名字只在/.test(cli))

console.log('\n' + (fail === 0 ? 'ALL PASS: ' : 'HAS FAIL: ') + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
