/**
 * 模型改名：服务端语义单测（直接驱动 rpc.js 的 dispatcher，不经过网络）。
 *
 * 为什么单测和真机测试都要有：
 *   - 真机测试证明"端到端能用"，但它依赖宿主进程里有哪一版代码；
 *   - 单测证明"代码本身对"，跟宿主有没有重启无关。
 * 两者都过才算这件事真的成立。
 *
 * 跑法：node test-rename-unit.mjs
 */
import { buildDispatcher } from '../lib/rpc.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  \u2713 ' + name) }
  else { fail += 1; console.log('  \u2717 ' + name + (extra === undefined ? '' : ' \u2014 ' + JSON.stringify(extra))) }
}

/** 造一个最小可用的 deps：patchConfig 写进内存，current 读出来。 */
function makeDeps(initial) {
  let cfg = structuredClone(initial)
  return {
    deps: {
      current: () => cfg,
      patchConfig: async (patch) => { cfg = { ...cfg, ...structuredClone(patch) }; return { ok: true } },
      keyStore: { records: [], list: () => [] },
      listenStatus: () => ({}),
      inflight: () => ({}),
      directory: { diagnostics: () => ({}) },
    },
    read: () => cfg,
  }
}

const BASE_MODEL = {
  id: 'cm_a', name: 'alpha', display: 'alpha', bindings: ['glm-5.3@xdpool'],
  enabled: true, createdAt: 1, timeoutMs: 10000, retries: 2,
}
const OTHER = {
  id: 'cm_b', name: 'beta', display: '\u4e3b\u529b\u00b7\u5feb\u901f', bindings: [], enabled: true, createdAt: 2,
}

async function run(deps, method, payload) {
  const dispatch = buildDispatcher({ logger: { warn() {}, error() {}, info() {} } }, deps)
  return dispatch(method, payload)
}

console.log('=== \u6a21\u578b\u6539\u540d\u8bed\u4e49\uff08\u5355\u6d4b\uff09 ===')

// ---------- M1 只改名：display 跟过去 ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(BASE_MODEL)] })
  const r = await run(deps, 'customModels/update', { id: 'cm_a', name: 'alpha-2' })
  ok('M1.1 \u8fd4\u56de ok', r.ok === true, r.error)
  ok('M1.2 name \u5df2\u6539', r.value?.model?.name === 'alpha-2', r.value?.model?.name)
  ok('M1.3 display \u8ddf\u7740\u6539\uff08\u539f\u672c\u7b49\u4e8e\u65e7\u540d\uff09', r.value?.model?.display === 'alpha-2', r.value?.model?.display)
  ok('M1.4 \u843d\u76d8\u7684 display \u4e5f\u53d8\u4e86', read().customModels[0].display === 'alpha-2', read().customModels[0].display)
  ok('M1.5 id \u4e0d\u53d8', read().customModels[0].id === 'cm_a', read().customModels[0].id)
  ok('M1.6 bindings \u4e0d\u53d8', JSON.stringify(read().customModels[0].bindings) === JSON.stringify(['glm-5.3@xdpool']), read().customModels[0].bindings)
}

// ---------- M2 用户自己起过显示名：改名不许冲掉 ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(OTHER)] })
  const r = await run(deps, 'customModels/update', { id: 'cm_b', name: 'beta-2' })
  ok('M2.1 \u6539\u540d\u6210\u529f', r.ok === true, r.error)
  ok('M2.2 \u81ea\u5b9a\u4e49\u663e\u793a\u540d\u4fdd\u7559', read().customModels[0].display === '\u4e3b\u529b\u00b7\u5feb\u901f', read().customModels[0].display)
}

// ---------- M3 显式传 display：以显式值为准 ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(BASE_MODEL)] })
  const r = await run(deps, 'customModels/update', { id: 'cm_a', name: 'alpha-3', display: '\u65b0\u663e\u793a\u540d' })
  ok('M3.1 \u663e\u5f0f display \u80dc\u51fa', read().customModels[0].display === '\u65b0\u663e\u793a\u540d', read().customModels[0].display)
  ok('M3.2 name \u540c\u65f6\u751f\u6548', read().customModels[0].name === 'alpha-3', read().customModels[0].name)
}

// ---------- M4 只改 display，不动 name ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(BASE_MODEL)] })
  await run(deps, 'customModels/update', { id: 'cm_a', display: '\u53ea\u6539\u663e\u793a\u540d' })
  ok('M4.1 name \u672a\u53d8', read().customModels[0].name === 'alpha', read().customModels[0].name)
  ok('M4.2 display \u5df2\u53d8', read().customModels[0].display === '\u53ea\u6539\u663e\u793a\u540d', read().customModels[0].display)
}

// ---------- M5 display 传空串：回落成（当前）name ----------
{
  const { deps, read } = makeDeps({ customModels: [{ ...structuredClone(BASE_MODEL), display: '\u65e7\u663e\u793a' }] })
  await run(deps, 'customModels/update', { id: 'cm_a', name: 'alpha-9', display: '' })
  ok('M5.1 \u7a7a display \u56de\u843d\u5230\u65b0 name', read().customModels[0].display === 'alpha-9', read().customModels[0].display)
}

// ---------- M6 负例：非法名 / 撞名 / 不存在 ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(BASE_MODEL), structuredClone(OTHER)] })
  const blank = await run(deps, 'customModels/update', { id: 'cm_a', name: '   ' })
  ok('M6.1 \u7a7a\u540d invalid_name', blank.ok === false && blank.error?.code === 'invalid_name', blank.error)
  const at = await run(deps, 'customModels/update', { id: 'cm_a', name: 'a@b' })
  ok('M6.2 \u542b @ invalid_name', at.ok === false && at.error?.code === 'invalid_name', at.error)
  const long = await run(deps, 'customModels/update', { id: 'cm_a', name: 'x'.repeat(65) })
  ok('M6.3 \u8d85 64 \u5b57 invalid_name', long.ok === false && long.error?.code === 'invalid_name', long.error)
  const dup = await run(deps, 'customModels/update', { id: 'cm_a', name: 'beta' })
  ok('M6.4 \u649e\u540d duplicate_name', dup.ok === false && dup.error?.code === 'duplicate_name', dup.error)
  const dupCase = await run(deps, 'customModels/update', { id: 'cm_a', name: 'BETA' })
  ok('M6.5 \u649e\u540d\u5927\u5c0f\u5199\u4e0d\u654f\u611f', dupCase.ok === false && dupCase.error?.code === 'duplicate_name', dupCase.error)
  const missing = await run(deps, 'customModels/update', { id: 'cm_nope', name: 'whatever' })
  ok('M6.6 \u4e0d\u5b58\u5728 not_found', missing.ok === false && missing.error?.code === 'not_found', missing.error)
  ok('M6.7 \u5931\u8d25\u540e\u914d\u7f6e\u672a\u88ab\u6539', read().customModels[0].name === 'alpha', read().customModels[0].name)
}

// ---------- M7 改成自己现在的名字：算无操作，不算撞名 ----------
{
  const { deps, read } = makeDeps({ customModels: [structuredClone(BASE_MODEL)] })
  const same = await run(deps, 'customModels/update', { id: 'cm_a', name: 'alpha' })
  ok('M7.1 \u6539\u6210\u81ea\u5df1\u7684\u540d\u5b57\u4e0d\u62a5\u9519', same.ok === true, same.error)
  ok('M7.2 name \u4ecd\u4e3a alpha', read().customModels[0].name === 'alpha', read().customModels[0].name)
}

console.log('')
console.log('==== ' + pass + ' passed / ' + fail + ' failed ====')
process.exit(fail === 0 ? 0 : 1)
