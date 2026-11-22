import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'
// dsh-llm 打在 app.asar 内部，node 无法直接 import；
// 这两个工厂只是构造消息对象，这里用最小等价实现代替（字段形状与官方一致）。
const createAssistantMessage = (input) => ({ role: 'assistant', content: input?.content ?? [], ...(input ?? {}) })
const createUserMessage = (input) => ({ role: 'user', content: input?.content ?? [], ...(input ?? {}) })
const src = readFileSync(`${LANTERN_DIR}/lib/index.js`, 'utf8')
const start = src.indexOf('async function* streamWithFailover')
const end = src.indexOf('\nfunction ', start + 100)
const fnSrc = src.slice(start, end)
const factory = new Function('maskSecrets','resolveTune','isSubstantiveChunk','isRetryableFailure','linkSignals','PLUGIN_ID','createAssistantMessage','createUserMessage',
  fnSrc + '\nreturn streamWithFailover')
const streamWithFailover = factory((x)=>x, (t)=>t??{}, (c)=>c?.type==='text-delta'&&c.text.length>0, ()=>false, (o)=>({signal:o??{},abort(){},dispose(){}}), 'dsh-lantern', createAssistantMessage, createUserMessage)

// 场景5：首包之前就有空 text-delta + 断流（缓冲中未提交的 delta 也要进前缀）
function makeStream(parts){ return { async *[Symbol.asyncIterator](){ for(const p of parts){ if(p.throw) throw new Error(p.throw); if(p.finishError) yield {type:'finish',reason:{kind:'error',failure:{message:p.finishError}}}; else yield p } } } }
const calls=[]
const sctx={ llm:{ stream:(o)=>{ calls.push(o.messages)
  if(o.provider==='p1') return makeStream([{type:'usage',usage:{a:1}},{type:'text-delta',text:'半截'},{throw:'drop'}])
  return makeStream([{type:'text-delta',text:'接上'},{type:'finish',reason:{kind:'stop'}}]) } } }
const plans=[{binding:'b1',provider:'p1',model:'m1'},{binding:'b2',provider:'p2',model:'m2'}]
const chunks=[]; const fo={attempts:[]}
for await (const c of streamWithFailover(sctx, {log:()=>{}}, plans, {messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}, fo, {timeoutMs:0,retries:0})) chunks.push(c)
console.log('S5 chunks:', JSON.stringify(chunks))
console.log('S5 resumed:', fo.resumed, 'prefix in call2:', calls[1]?.[1]?.content?.[0]?.text)

// 场景6：MAX_RESUMES 边界 —— 两个后端都断流：第一次续写到 b2，b2 再断 → 无第三个后端 → throw
const sctx6={ llm:{ stream:(o)=> calls.push(o.messages) && makeStream([{type:'text-delta',text:o.provider==='p1'?'A':'B'},{throw:'drop'+o.provider}]) } }
let fo6={attempts:[]}
try {
  for await (const c of streamWithFailover(sctx6, {log:()=>{}}, plans, {messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}, fo6, {timeoutMs:0,retries:0})) console.log('S6 c',c)
  console.log('S6 NO THROW — check')
} catch(e) { console.log('S6 threw:', e.message, 'flag=', e.lanternCommittedFailure, 'attempts=', fo6.attempts.length) }
