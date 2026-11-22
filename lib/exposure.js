/**
 * 对外暴露面（exposure）：把内部拓扑与内部面板指引从错误信息里抹掉。
 *
 * 为什么需要这一层：
 * 这个网关的用途是「把一堆来路不同、时好时坏的模型聚合成一个稳定的名字」再给
 * 别人用。终端用户看到的应该只有聚合后的那一个模型名，而不是
 * 「deepseek-v4.1-flash 不在 provider「trae」的模型列表中」。
 *
 * 后者有两个问题，而且是两个不同的问题：
 * 1. 暴露内部拓扑——provider 名、绑定名、账号分布全都在告诉对方
 *    「你这套是拼起来的，背后有 trae / xdpool 好几个账号」。这属于运营信息泄露；
 * 2. 给出无效指引——「请到 设置 → LANtern → 自定义模型 里检查绑定」是写给
 *    网关管理员看的，终端用户照做只会一脸茫然（他根本没有这个设置面板）。
 *
 * 因此本模块只做一件事：把错误文案与错误对象按「给谁看」重新组织。
 * 不改变任何判定逻辑、不吞掉错误——管理员仍然能在日志与服务端侧记录里看到
 * 全部细节，只是不再通过 HTTP 响应泄给调用方。
 *
 * @module dsh-lantern/exposure
 */

/**
 * 指向「设置 → LANtern ...」这类内部面板路径的说法。
 *
 * 只用来做**兜底清洗**——理想情况是每条文案都在源头写对，
 * 但错误文案散落在 auth/index/media/capabilities/breaker 五个文件里，
 * 逐个改写容易漏。这里再用一次替换网兜底，漏一条也不会把内部路径发出去。
 */
const INTERNAL_HINT_PATTERNS = [
  // 整块括号：文案里最常见的形态是「（……设置 → LANtern → xxx 调整）」。
  // 必须**先**整块删掉，否则下面按句删的规则会留下一个悬空的「（限额可在 」。
  /（[^（）]*设置\s*→\s*LANtern[^（）]*）/g,
  /\([^()]*设置\s*→\s*LANtern[^()]*\)/g,
  /设置\s*→\s*LANtern\s*→\s*[^。；;）)]*[）)]?/g,
  /请(到|在)\s*设置\s*→\s*LANtern[^。；;]*[。；;]?/g,
  /设置\s*→\s*LANtern[^。；;]*[。；;]?/g,
]

/**
 * 删掉内部指引后留下的**残句**。
 *
 * 这是上面那批正则的必然副作用：句子是「请稍后重试，或在 设置 → LANtern → 限额与并发 中调整」，
 * 把中间那段挖走之后剩下「请稍后重试，或在。」——比不清洗更难看。
 * 残句没法逐条枚举（每条文案挖走的位置都不同），所以按语法特征收敛：
 * 引导词（或/请/可/需要/如需）+ 介词（在/到）+ 方位（中/里）后面直接跟标点，
 * 说明宾语已经被删掉了，这半句就是垃圾，连同前面的逗号一起丢掉。
 */
/** 每条规则带自己的替换串——有的要保住句末标点，有的要整段删掉。 */
const DANGLING_CLAUSE_PATTERNS = [
  // 「请稍后重试，或在。」「：请到。」→ 挖空的半句连同前面的标点一起丢，只留句号
  [/[，,、；;：:]?\s*(?:或|请|可|需要|如需)?\s*(?:在|到)\s*(?:中|里)?\s*([。！？；;])/g, '$1'],
  // 「可在，」「或请，」——引导词后面紧跟逗号，前后都是完整句时它是纯累赘
  [/(?:或|请|可|需要|如需)\s*(?:在|到)\s*(?:中|里)?\s*[，,]\s*/g, ''],
  // 「，或手动勾选声明。」——以「或」开头的尾巴指向管理员动作，调用方做不了
  [/(?:[，,]\s*)?或\s*手动[^。；;]*[。；;]?/g, ''],
  // 「没有可用于生图的上游供应商：请到」「…或让管理员在」
  //
  // 上面那批规则的共同前提是"挖空后还留着句末标点"，因此都写成"后面跟标点"。
  // 但指引正好在**句尾**时，它后面什么都没有——挖掉之后介词短语就悬在末尾，
  // 没有标点收尾，按标点设计的规则一条都接不住。实测对外露出的是
  // 「…请到」/「…或让管理员在」这种半句。
  //
  // 之所以要求前面必须先有标点：`在`/`到`是常用词的尾字（现在、存在、达到），
  // 只按"末尾是在/到"删会把正常句子啃掉一个字。
  [/[，,：:；;、]\s*(?:(?:或|请|可|需要|如需)\s*)?(?:让\s*)?(?:管理员\s*)?(?:在|到)\s*$/, ''],
]

/** 「（来源：declared）」这类标注是能力探测的内部分类，不该出现在对外文案里。 */
const INTERNAL_ANNOTATION_PATTERNS = [
  /（\s*来源\s*[：:][^）]*）/g,
  /\(\s*来源\s*[：:][^)]*\)/g,
]

/** 指向宿主 WorkBuddy 开关的说法，同样只对管理员有意义。 */
const HOST_HINT_PATTERNS = [
  /（设置\s*→\s*WorkBuddy[^）)]*）/g,
  /设置\s*→\s*WorkBuddy\s*→\s*[^。；;）)]*[。；;）]?/g,
]

/** 形如 model@provider 的绑定名（provider 段只含小写字母数字连字符）。 */
const BINDING_PATTERN = /[A-Za-z0-9_.:\/-]+@[a-z0-9-]+/g

/** provider「xxx」/ provider "xxx" 这类指名道姓的说法。 */
const PROVIDER_QUOTE_PATTERN = /provider\s*[「"']([^」"']+)[」"']/g

/** 默认开关：开启（这是面向客户的网关，默认就该藏起来）。 */
export const DEFAULT_EXPOSURE = Object.freeze({
  maskTopology: true,
  maskInternalHints: true,
})

/**
 * 当前配置是否要求脱敏。
 *
 * 默认 true：老的 config.json 里没有 exposure 段时，行为必须是藏起来——
 * 这类开关默认值漂移的后果是「以为藏了、其实全裸」，比不做还糟。
 *
 * @param cfg - 当前配置。
 * @returns 是否脱敏。
 */
export function isMasked(cfg) {
  return isTopologyMasked(cfg) || isHintMasked(cfg)
}

/**
 * 是否要藏内部拓扑（provider 名、绑定名、逐后端失败原因）。
 *
 * 与 isMasked 分开是为了让调用方能只藏拓扑、仍然保留面板指引——
 * 反过来（留拓扑、藏指引）也要能表达。
 *
 * @param cfg - 当前配置。
 * @returns 是否藏拓扑。
 */
export function isTopologyMasked(cfg) {
  const section = cfg?.exposure
  if (section === undefined || section === null) return true
  return section.maskTopology !== false
}

/**
 * 是否要藏「设置 → LANtern → …」这类只对管理员有意义的指引。
 *
 * @param cfg - 当前配置。
 * @returns 是否藏内部指引。
 */
export function isHintMasked(cfg) {
  const section = cfg?.exposure
  if (section === undefined || section === null) return true
  return section.maskInternalHints !== false
}

/**
 * 清洗一段面向终端用户的错误文案。
 *
 * 做的事（顺序有意义）：
 * 1. 去掉「设置 → LANtern …」/「设置 → WorkBuddy …」这类内部指引；
 * 2. 把 model@provider 收敛成 model（模型名是调用方本来就填的，不算泄露）；
 * 3. 把 provider「xxx」换成一中性说法。
 *
 * @param text - 原始文案。
 * @param cfg - 当前配置（决定是否真的清洗）。
 * @returns 清洗后的文案。
 */
export function publicMessage(text, cfg) {
  const input = typeof text === 'string' ? text : ''
  if (input.length === 0) return input
  if (!isMasked(cfg)) return input

  let out = input
  // 两个开关互不干扰：只藏拓扑时，面板指引仍然照发（管理员自己调试要用）。
  if (isHintMasked(cfg)) {
    for (const pattern of [...INTERNAL_HINT_PATTERNS, ...HOST_HINT_PATTERNS]) {
      out = out.replace(pattern, '')
    }
    // 挖走指引之后必有残句，先收拾残句再整理标点——顺序不能反：
    // 反过来会先把「，或在。」里的句号吃掉，残句就没了收尾锚点。
    for (const [pattern, replacement] of DANGLING_CLAUSE_PATTERNS) {
      out = out.replace(pattern, replacement)
    }
  }
  // 内部标注（来源：declared）无论哪个开关都该藏：它既是拓扑提示，
  // 又会让人以为「declared」是某种他能查到的状态。
  for (const pattern of INTERNAL_ANNOTATION_PATTERNS) {
    out = out.replace(pattern, '')
  }
  if (isTopologyMasked(cfg)) {
    out = out.replace(BINDING_PATTERN, (match) => match.slice(0, match.lastIndexOf('@')))
    out = out.replace(PROVIDER_QUOTE_PATTERN, '所选上游')
  }
  // 清洗后可能留下连续空格 / 悬空标点，收拾一下免得文案看起来像坏了
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；、）])/g, '$1')
    .replace(/([（])\s+/g, '$1')
    .trim()
  // 全被清洗掉时给一句能站住的话，不能返回空字符串
  return out.length > 0 ? out : '服务暂时不可用，请稍后重试'
}

/**
 * 清洗「上游实现细节」类字段（媒体响应 `x-lantern` 与自定义工具响应共用）。
 *
 * 这类字段的问题和 provider 名是同一类：终端客户看到 hunyuan-image-alpha、
 * workbuddy_draw_image、direct/tool 之后做不了任何事，却能反推出
 * 「这家在转卖谁的模型、宿主机上开了哪些插件」。所以默认一律不出现。
 *
 * `model` 单独处理：用户自己填了名字（model_requested）时，上游真实模型名
 * 就是纯多余信息；用户没填时留着它还能帮排查"到底走了哪条默认路径"。
 *
 * @param extras - 即将作为 `x-lantern` 输出的对象。
 * @param cfg - 当前配置。
 * @returns 清洗后的副本（不改原对象）。
 */
export function maskUpstreamExtras(extras, cfg) {
  if (extras === undefined || extras === null) return extras
  if (!isTopologyMasked(cfg)) return extras
  const out = { ...extras }
  // 内部实现细节：一律不对外。
  delete out.host_tool
  delete out.tool
  delete out.upstream_model
  delete out.upstream_models
  delete out.catalog
  delete out.pinned_model
  delete out.backend
  // `provider` 与上面那些是同一类东西：实测生图响应里它带着 `"provider":"replicate"`、
  // 视频响应里带着 `"provider":"my-generic-vendor"`——直接就是"这家在转卖谁"的答案。
  // 早先漏了它，等于脱敏列表补了一半：model 藏了，provider 还在。
  delete out.provider
  delete out.providerName
  delete out.provider_name
  if (out.model_requested !== undefined && out.model_requested !== '') delete out.model
  // note 里可能夹着"上游在右下角硬加水印"之类的实现说明与面板路径。
  if (typeof out.note === 'string') out.note = publicMessage(out.note, cfg)
  return out
}

/**
 * 脱敏版的能力视图：只留"这个模型能干什么"，不留"它是谁的"。
 *
 * 为什么需要这一步：`capabilities.describe()` 的返回值里除了 12 个能力字段，
 * 还夹着 `name` / `description`（来自上游模型清单，实测有
 * `name:"hunyuan-image-alpha"`、`description:"腾讯混元生图（内部账号 A）"`）
 * 以及 `authoritativeRaw`。早先 `publicModelRow` 把整个 caps 原样塞进
 * `x-lantern.capabilities`，于是**脱敏开着也照样**把上游厂商名与内部账号
 * 写在响应里——藏了 id、藏了 owned_by，却在自己拼的字段里全说了。
 *
 * 保留 `note` 但过一遍 `publicMessage`：它是能力探测的说明文字，
 * 对排障有用，但可能提到面板路径或上游名。
 *
 * @param caps - 原始能力视图（可为 undefined）。
 * @param cfg - 当前配置。
 * @returns 脱敏后的能力视图（不改原对象）。
 */
function maskedCapabilities(caps, cfg) {
  if (caps === undefined || caps === null || typeof caps !== 'object') return caps
  const out = { ...caps }
  delete out.name
  delete out.description
  delete out.display
  // authoritativeRaw 是"权威来源原样值"，形态不对外承诺，直接不给
  delete out.authoritativeRaw
  if (typeof out.note === 'string') out.note = publicMessage(out.note, cfg)
  return out
}

/**
 * 组一个 OpenAI 兼容的模型行——脱敏时把拓扑整列抹掉。
 *
 * 未脱敏的那一版（provider / providerName / 真实 model / 「model（provider名）」）
 * 是给管理员排障用的；对终端客户来说，那一整行就是一份"你背后有哪几个渠道"的清单。
 *
 * @param entry - 目录条目（需含 publicName；未脱敏时还需 provider/providerName/model）。
 * @param caps - 可选能力视图。
 * @param cfg - 当前配置。
 * @returns OpenAI `/v1/models` 条目。
 */
export function publicModelRow(entry, caps, cfg) {
  // ── 推理档位的外显（第十四轮 #156）──
  //
  // OpenAI 的 `/v1/models` **没有**"这个模型支持哪些推理档位"这个标准字段。
  // 所以客户端（DSH / Cherry Studio / 各类软件）**读不到**我们放在
  // `x-lantern.capabilities.reasoning.efforts` 里的信息 —— 那是私有扩展，
  // 只有认识它的代码才会看（实测 DSH 的 asar 里 "x-lantern" 出现 0 次）。
  //
  // 后果：客户把网关当 OpenAI 源导入后，推理档位下拉框是空的 —— 改不了档。
  //
  // 这里把同一份档位列表**同时**放在几个客户端可能会读的位置：
  //   · `reasoning_efforts` / `supported_reasoning_efforts`（常见的自定义命名）
  //   · `capabilities.reasoning_efforts`（部分客户端认这个嵌套形状）
  // 这是"多写几个可能的位置"，不保证任何客户端会读，但比只藏在 x-lantern 里强。
  //
  // ── 对外只暴露四档契约（#195 回滚：统一优先）──
  //
  // 设计决定（用户定的）：**对外统一四档**，不暴露各家的真实词表。
  //
  // 理由：如果 A 模型显示 `low/high/xhigh`、B 模型显示 `low/medium/high`，
  // 客户端（尤其把多个模型并列展示的）会觉得混乱，用户也无从比较。
  // 统一成 minimal/low/medium/max 后，任何客户端对任何模型都看到同一组选项。
  //
  // 真实词表的映射在**内部**完成（effort-contract.js 的 LEVEL_POSITION +
  // rankOf 最近分位算法）：调用方说 `max`，网关自己算出该模型最强那一档，
  // 落到 `xhigh` / `extra_high` / `high` 都行。响应头
  // `X-Lantern-Effort-Served` 会如实报告实际下发的词，便于排障。
  //
  // 唯一保留的额外信息：`reasoning_default_effort` ——
  // 模型自己声明的默认档（不参与档位列表，只影响客户端的初始选中项）。
  const contractLevels = Array.isArray(caps?.contractLevels)
    ? caps.contractLevels.map((c) => c?.level).filter((x) => typeof x === 'string')
    : []
  const effortsCompat = contractLevels.length > 0 ? contractLevels : undefined
  const modelDefaultEffort = typeof caps?.reasoning?.defaultEffort === 'string'
    ? caps.reasoning.defaultEffort
    : undefined

  /** 统一的档位字段（两处 return 共用，避免分叉）。 */
  const effortFields = effortsCompat === undefined ? {} : {
    reasoning_efforts: effortsCompat,
    supported_reasoning_efforts: effortsCompat,
    capabilities: { reasoning_efforts: effortsCompat },
    ...(modelDefaultEffort === undefined ? {} : { reasoning_default_effort: modelDefaultEffort }),
  }

  if (!isTopologyMasked(cfg)) {
    return {
      id: entry.publicName,
      object: 'model',
      created: 0,
      owned_by: entry.provider,
      root: entry.model,
      ...effortFields,
      'x-lantern': {
        provider: entry.provider,
        providerName: entry.providerName,
        model: entry.model,
        display: `${entry.model}（${entry.providerName}）`,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities }),
        ...(caps === undefined ? {} : { capabilities: caps }),
      },
    }
  }
  return {
    id: entry.publicName,
    object: 'model',
    created: 0,
    // OpenAI 客户端会把 owned_by 显示出来，所以不能空着；
    // 但也不能写真实 provider —— 统一署名为网关自己。
    owned_by: 'lantern',
    root: entry.publicName,
    ...effortFields,
    'x-lantern': {
      custom: false,
      model: entry.publicName,
      ...(caps === undefined ? {} : { capabilities: maskedCapabilities(caps, cfg) }),
    },
  }
}

/**
 * 把一次上游失败的 `{message, code}` 换成对外安全的版本。
 *
 * 为什么单列一个函数：**流式通道改不了 HTTP 状态码**（首帧一发就是 200），
 * 只能把错误塞进 data 帧。于是"非流式藏得好、流式把上游原文吐出去"是最容易
 * 出现的分叉——两条通道必须过同一个口子。
 *
 * 对外只保留调用方能行动的信息：
 * - 限流类 → 告诉他"稍后再试"（这确实是他唯一能做且该做的事）；
 * - 其余 → 一句通用的"生成失败"。
 * 上游原文（`模型 X 不在 provider「trae」的模型列表中`、`NO_IMAGE_MODEL` …）
 * 只进本机日志。
 *
 * @param failure - 原始 `{message, code, status}`（可为 undefined）。
 * @param cfg - 当前配置。
 * @returns `{message, code}`。
 */
export function publicFailurePatch(failure, cfg) {
  const rawMessage = typeof failure?.message === 'string' ? failure.message : '上游模型调用失败'
  const rawCode = typeof failure?.code === 'string' ? failure.code : undefined
  if (!isMasked(cfg)) {
    return { message: rawMessage, code: rawCode ?? 'upstream_error' }
  }
  // 限流是唯一值得如实告知的语义：客户端据此退避，而且它不透露任何拓扑。
  const rateLimited =
    failure?.status === 429 ||
    /rate[_-]?limit|too[_-]?many|quota|throttl|并发|限流/i.test(rawCode ?? '') ||
    /rate[_-]?limit|too[_-]?many|quota|throttl/i.test(rawMessage)
  if (rateLimited) return { message: '请求过于频繁，请稍后重试', code: 'rate_limit_exceeded' }
  return { message: '生成失败，请稍后重试；若持续如此请联系服务提供方', code: 'upstream_error' }
}

/**
 * 把一个内部绑定名换成对外的中性称呼。
 *
 * 「第 1 个上游」「第 2 个上游」——保留**顺序**是有价值的（它对应故障转移的
 * 优先级，能帮管理员判断是不是首选后端挂了），但不保留身份。
 *
 * @param index - 在链里的下标（0 起）。
 * @returns 对外称呼。
 */
export function publicUpstreamLabel(index) {
  const n = Number.isInteger(index) && index >= 0 ? index + 1 : 1
  return '第 ' + n + ' 个上游'
}

/**
 * 把内部 attempts / skipped 记录改写成对外形状。
 *
 * 对外只保留三样东西：第几个、有没有成、花了多久。
 * provider / model / binding / errorCode 一律不出——errorCode 里的
 * rate_limit / model_not_found 之类会直接告诉对方「你后端配错了」。
 *
 * @param attempts - 内部尝试记录。
 * @param cfg - 当前配置。
 * @returns 对外尝试记录（未脱敏时原样返回）。
 */
export function publicAttempts(attempts, cfg) {
  if (!Array.isArray(attempts)) return undefined
  if (!isTopologyMasked(cfg)) return attempts
  return attempts.map((a, index) => ({
    upstream: publicUpstreamLabel(index),
    ok: a?.ok === true,
    ms: typeof a?.ms === 'number' ? a.ms : 0,
  }))
}

/**
 * 构造「所有后端都失败」时的对外错误体。
 *
 * 关键取舍：不逐条列出每个后端为什么失败。
 * 那份清单对终端用户毫无用处（他改不了任何一个后端），
 * 却正好是最完整的拓扑快照。给一句能行动的话就够了。
 *
 * @param options - { target, attempts, cfg }。
 * @returns { message, details }。
 */
export function publicAllFailedError(options) {
  const { target, attempts, cfg } = options ?? {}
  const name = typeof target?.publicName === 'string' && target.publicName.length > 0 ? target.publicName : '该模型'
  const masked = isTopologyMasked(cfg)
  const tried = Array.isArray(attempts) ? attempts.length : 0

  if (!masked) {
    return {
      message: '模型「' + name + '」的所有后端都调用失败',
      details: { attempts },
    }
  }
  return {
    message:
      '模型「' + name + '」暂时不可用' +
      (tried > 1 ? '（已依次尝试 ' + tried + ' 个上游）' : '') +
      '，请稍后重试。',
    details: { attempts: publicAttempts(attempts, cfg) },
  }
}

/**
 * 构造「没有任何可用后端」时的对外错误体（解析期就失败，一次请求都没发出去）。
 *
 * @param options - { target, skipped, cfg }。
 * @returns { message, details }。
 */
export function publicNoBackendError(options) {
  const { target, skipped, cfg, allCooling, coolingCount } = options ?? {}
  const name = typeof target?.publicName === 'string' && target.publicName.length > 0 ? target.publicName : '该模型'

  // ── #208：全部冷却不是"没配后端"，是"暂时都不可用" ──
  //
  // 用户要求：全链冷却时直接回"模型暂不可用"，不要按原序全试
  // （那会白等 N × timeoutMs）。
  //
  // 这两种情况的对外措辞必须不同，否则运维会误判：
  //   · 没有可用后端（绑定为空 / 全被能力闸门筛掉）→ 是**配置**问题
  //   · 全部在冷却 → 是**临时**问题，等一会儿会自愈
  // 前者要人去看配置，后者只需重试或换模型——把它们说成同一句话
  // 会让用户以为配置坏了，反复排查一个根本不存在的配置错误。
  if (allCooling === true) {
    const n = typeof coolingCount === 'number' && coolingCount > 0 ? coolingCount : undefined
    if (!isTopologyMasked(cfg)) {
      return {
        message: '模型「' + name + '」暂不可用：' +
          (n === undefined ? '全部后端' : '全部 ' + n + ' 个后端') +
          '刚因连续失败进入冷却，冷却到期后自动恢复。可稍后重试，或改用其它模型。',
        details: { allCooling: true, coolingCount: n, skipped },
      }
    }
    return {
      message: '模型「' + name + '」暂不可用：后端正在冷却中，请稍后重试或改用其它模型。',
      details: { allCooling: true },
    }
  }

  if (!isTopologyMasked(cfg)) {
    const detail = Array.isArray(skipped) && skipped.length > 0
      ? '（' + skipped.map((s) => s.binding + '：' + s.reason).join('；') + '）'
      : '（绑定列表为空）'
    return {
      message: '自定义模型「' + name + '」当前没有可用的后端' + detail,
      details: { skipped },
    }
  }
  return {
    message: '模型「' + name + '」当前不可用：服务端尚未配置任何可用上游，请联系服务提供方。',
    details: {},
  }
}
