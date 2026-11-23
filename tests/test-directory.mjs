import { ModelDirectory, slugOf, publicNameOf, parsePublicName } from '../lib/directory.js'

let pass = 0; let fail = 0
const check = (n, ok, extra) => { if (ok) { pass += 1; console.log('  ok ' + n) } else { fail += 1; console.log('  FAIL ' + n + (extra === undefined ? '' : '  -> ' + extra)) } }
const warns = []
// 造一个假 ctx：providers/models 由测试给
const make = (providers, modelsOf, cfg = {}) => new ModelDirectory(
  { llm: { listProviders: () => providers, listModels: (id) => Promise.resolve(modelsOf[id] ?? []) }, logger: { warn: (m) => warns.push(m) } },
  () => cfg,
)
console.log('\n-- U1 slug / 全名 --')
check('U1a slug 小写下划线转横线', slugOf('WorkBuddy_Global') === 'workbuddy-global')
check('U1b slug 空串兜底', slugOf('') === 'provider')
check('U1c slug 截断 24', slugOf('a'.repeat(40)).length === 24)
check('U1d 全名', publicNameOf('glm-5.3', 'trae') === 'glm-5.3@trae')
check('U1e 模型名带 @ 转义', publicNameOf('a@b', 'trae') === 'a@@b@trae')
const parsed = parsePublicName('a@@b@trae')
check('U1f 反解还原 @', parsed !== undefined && parsed.model === 'a@b' && parsed.slug === 'trae')
check('U1g 无反解 undefined', parsePublicName('nomodel') === undefined)
check('U1h 尾 @ undefined', parsePublicName('x@') === undefined)
check('U1i 非法 slug undefined', parsePublicName('x@A-B') === undefined)

console.log('\n-- U2 目录构建与过滤 --')
{
  const d = make(
    [{ id: 'trae', name: 'Trae' }, { id: 'xdpool', name: 'XDPool' }],
    { trae: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }], xdpool: [{ id: 'glm-5.3' }] },
  )
  const list = await d.refresh()
  check('U2a 三个条目', list.length === 3, 'got ' + list.length)
  check('U2b 公开名正确', d.resolve('glm-5.3@trae') !== undefined)
  check('U2c 未知模型返回 undefined', d.resolve('nope@trae') === undefined)
  const diag = d.diagnostics()
  check('U2d 两个 provider 可见', diag.providers.length === 2)
  check('U2e publicCount=3', diag.publicCount === 3)
}

console.log('\n-- U3 ★ 裸模型名不再写死 workbuddy 偏好 --')
{
  // 两家都提供 glm-5.3；按 list() 排序（provider 名升序）=> trae 在前
  const d = make(
    [{ id: 'workbuddy' }, { id: 'trae' }],
    { workbuddy: [{ id: 'glm-5.3' }], trae: [{ id: 'glm-5.3' }] },
  )
  await d.refresh()
  const hit = d.resolveByModelId('glm-5.3')
  check('U3a 命中字典序第一个（trae < workbuddy）', hit?.provider === 'trae', 'got ' + hit?.provider)
  check('U3b 记了一条歧义 warn', warns.some((m) => m.includes('裸模型名') && m.includes('glm-5.3')))
  // 再调一次不该重复刷日志
  const before = warns.length
  d.resolveByModelId('glm-5.3')
  check('U3c 同一模型不重复告警', warns.length === before)
  // 唯一命中时不告警
  const d2 = make([{ id: 'workbuddy' }], { workbuddy: [{ id: 'solo' }] })
  await d2.refresh()
  d2.resolveByModelId('solo')
  check('U3d 唯一命中不告警', warns.filter((m) => m.includes('solo')).length === 0)
  check('U3e 未命中返回 undefined', d.resolveByModelId('nope') === undefined)
}

console.log('\n-- U4 过滤（P16） --')
{
  const d = make(
    [{ id: 'trae' }, { id: 'xdpool' }],
    { trae: [{ id: 'm1' }, { id: 'm2' }], xdpool: [{ id: 'm1' }] },
    { filters: { providers: ['xdpool'], models: [], allowedModels: [] } },
  )
  const list = await d.refresh()
  check('U4a 被排除的 provider 不出现在目录', !list.some((e) => e.provider === 'xdpool'))
  check('U4b isPubliclyAllowed 对排除 provider 为 false', d.isPubliclyAllowed('xdpool', 'm1') === false)
  check('U4c 未排除的是 true', d.isPubliclyAllowed('trae', 'm1') === true)
}
{
  const d = make(
    [{ id: 'trae' }],
    { trae: [{ id: 'm1' }, { id: 'm2' }] },
    { filters: { providers: [], models: ['m2'], allowedModels: [] } },
  )
  const list = await d.refresh()
  check('U4d 黑名单生效', list.length === 1 && list[0].model === 'm1')
  check('U4e 黑名单对宽松路由也生效', d.isPubliclyAllowed('trae', 'm2') === false)
}
{
  const d = make(
    [{ id: 'trae' }],
    { trae: [{ id: 'm1' }, { id: 'm2' }] },
    { filters: { providers: [], models: [], allowedModels: ['m1'] } },
  )
  const list = await d.refresh()
  check('U4f 白名单只放 m1', list.length === 1 && list[0].model === 'm1')
  check('U4g 白名单外的 isPubliclyAllowed=false', d.isPubliclyAllowed('trae', 'm2') === false)
}

console.log('\n-- U5 故障隔离 --')
{
  const d = new ModelDirectory(
    {
      llm: {
        listProviders: () => [{ id: 'good' }, { id: 'bad' }],
        listModels: (id) => (id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve([{ id: 'm' }])),
      },
      logger: { warn: () => {} },
    },
    () => ({}),
  )
  const list = await d.refresh()
  check('U5a 坏 provider 不影响好的', list.length === 1 && list[0].provider === 'good')
  check('U5b 坏 provider 记了原因', d.diagnostics().allProviders.find((r) => r.id === 'bad')?.hiddenReason?.includes('list_failed') === true)
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
