window.__ModuleLoader__.load({
  id: 'dsh-lantern',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    // ────────────────────────────── 常量与工具 ──────────────────────────────

    const ENDPOINT = 'lantern'
    const RPC_PATH = '/api/lantern'

    /** 把管理 RPC 的 `{ok,value}` 信封解包成值或抛错。 */
    function unwrap(result) {
      if (result && result.ok === true) return result.value
      if (result && result.ok === false) {
        const error = new Error(result.error && result.error.message ? result.error.message : 'LANtern 请求失败')
        error.code = result.error && result.error.code
        throw error
      }
      return result
    }

    /** 生成一个 class 名（统一前缀 .dim-lt-）。 */
    const cx = (...names) => names.filter(Boolean).map((n) => `dim-lt-${n}`).join(' ')

    /** 格式化时间戳为本地可读。 */
    function fmtTime(ts) {
      if (ts === null || ts === undefined) return '—'
      try {
        return new Date(ts).toLocaleString()
      } catch {
        return String(ts)
      }
    }

    /**
     * #235：相对时间（"3 分钟前" / "2 天前"）。
     *
     * 为什么需要：Key 列表原来只显示绝对时间戳（2026/8/15 14:23:11），
     * 判断"这个 Key 还活着吗"要用当前时间去减 —— 多一个心智负担。
     * 相对时间一眼就能看出"三个月没用过了"。
     *
     * 超过 30 天直接显示日期（"3 个月前"再精确也没意义，日期更好定位）。
     * @param ts - 毫秒时间戳。
     * @returns 相对时间文本。
     */
    function fmtAgo(ts) {
      if (ts === null || ts === undefined) return '从未'
      const diff = Date.now() - Number(ts)
      if (!Number.isFinite(diff) || diff < 0) return fmtTime(ts)
      const sec = Math.floor(diff / 1000)
      if (sec < 60) return '刚刚'
      const min = Math.floor(sec / 60)
      if (min < 60) return `${min} 分钟前`
      const hr = Math.floor(min / 60)
      if (hr < 24) return `${hr} 小时前`
      const day = Math.floor(hr / 24)
      if (day <= 30) return `${day} 天前`
      try {
        return new Date(Number(ts)).toLocaleDateString()
      } catch {
        return fmtTime(ts)
      }
    }

    // ────────────────────────────── 样式 ──────────────────────────────

    const STYLES = `
.dim-lt-page { display: flex; flex-direction: column; height: 100%; font-family: var(--dsw-font-family); }
.dim-lt-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-lt-brandName { font-size: 18px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-lt-brandDesc { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 3px 0 0; }
.dim-lt-headerActions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.dim-lt-layout { display: flex; flex: 1; overflow: hidden; }
/* 左栏宽度自适应：设置窗口在本机只有 ~800px，固定 208px 会把右栏压到 ~340px，
   长文案必然把表格挤变形（实测：绑定单元格被撑到 215px 高）。
   这里用 clamp 让它随可用宽度收缩，右栏因此拿到更多空间。 */
.dim-lt-rail { width: clamp(124px, 26%, 176px); flex-shrink: 0; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 6px; }
.dim-lt-railDivider { height: 1px; background: var(--dsw-alias-border-l2, #eef0f3); margin: 6px 4px; }
.dim-lt-railFoot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); padding: 6px 10px 2px; }
.dim-lt-nav { width: 100%; min-height: 42px; display: grid; grid-template-columns: 26px minmax(0,1fr) auto; align-items: center; gap: 9px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 12px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.dim-lt-nav:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); }
.dim-lt-nav[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-navIcon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, #1677ff 10%, transparent); font-size: 13px; }
.dim-lt-navLabel { min-width: 0; display: grid; }
/* 名称与 slug **都必须省略号截断**：
   只给 strong 加省略号时，slug（如 deepseek-official）会换行成两行，
   把该按钮撑得比其它按钮高、整列高度参差（用户实测发现）。 */
.dim-lt-navLabel strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-lt-navLabel span { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-lt-navCount { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dim-lt-panel { flex: 1; overflow-y: auto; padding: 16px 16px 40px; min-width: 0; }
.dim-lt-section { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; background: var(--dsw-alias-bg-layer-3, #fff); }
.dim-lt-sectionTitle { font-size: 14px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); margin: 0 0 4px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-lt-sectionHint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); margin: 0 0 10px; line-height: 1.55; }
.dim-lt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dim-lt-field { display: grid; gap: 4px; }
.dim-lt-fieldLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-input, .dim-lt-select { height: 30px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: inherit; font: inherit; font-size: 13px; }
/* select 的宽度默认由最长 option 文本撑开（"DeepSeek-V4-Pro-Official@trae — DeepSeek-V4-Pro · x0.72" 这类），
   会把 .dim-lt-row 撑破并在 .dim-lt-panel 上产生横向滚动条（浏览器实测发现）。
   max-width + min-width:0 让它跟随容器收缩，长文本靠原生下拉展开查看。 */
.dim-lt-select { max-width: 100%; min-width: 0; flex: 1 1 auto; text-overflow: ellipsis; }
.dim-lt-input:focus, .dim-lt-select:focus { outline: none; border-color: #1677ff; }
.dim-lt-input[type="number"] { width: 92px; }
.dim-lt-btn { font-size: 12px; line-height: 18px; padding: 4px 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: inherit; cursor: pointer; font-family: inherit; transition: border-color .15s ease, background .15s ease; }
.dim-lt-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, #1677ff 5%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-btn:disabled { opacity: .45; cursor: not-allowed; }
.dim-lt-btnPrimary { border-color: #1677ff; color: #1677ff; background: color-mix(in srgb, #1677ff 8%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-btnDanger { border-color: color-mix(in srgb, #d4380d 45%, var(--dsw-alias-border-l2, #dfe1e5)); color: #d4380d; }
.dim-lt-btnDanger:hover:not(:disabled) { background: color-mix(in srgb, #d4380d 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dim-lt-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary, #555); padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eef0f3); white-space: nowrap; }
/* td 允许长 token 换行（IP、模型名等），避免把表格撑宽/撑高 */
.dim-lt-table td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #eef0f3) 60%, transparent); vertical-align: middle; overflow-wrap: anywhere; }
.dim-lt-table tr:last-child td { border-bottom: none; }
/* 单行省略号截断（配合 title 悬停显示全文） */
.dim-lt-ellipsis { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Key 名称单元格：名称截断 + 可选 ⓘ 图标同一行 */
.dim-lt-keyNameCell { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dim-lt-keyNameCell .dim-lt-ellipsis { min-width: 0; }
/* 「已删除」的 Key 行整体置灰（不删除数据，只是视觉降级） */
.dim-lt-rowDeleted td { color: var(--dsw-alias-label-tertiary, #8a8f99); }
      .dim-lt-rowDeleted .dim-lt-mono { color: var(--dsw-alias-label-tertiary, #8a8f99); }
      /* #234：勾选行的高亮（批量操作时让"选了几行"一眼可见） */
      /* #235：迷你趋势图单元格（固定宽度，避免行高跳动） */
      .dim-lt-sparkCell { width: 80px; padding-right: 4px; }
      .dim-lt-rowSelected td { background: color-mix(in srgb, #1677ff 7%, transparent); }
/* ⓘ 注释图标：悬停显示 title（原生 tooltip，不占版面） */
.dim-lt-infoIcon { flex-shrink: 0; cursor: help; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
/* 绑定地址单元格：地址 + ⓘ 同一行，避免说明文字把这一列撑高 */
.dim-lt-bindCell { display: flex; align-items: center; gap: 4px; }
/* 状态列（含「运行中」药丸）保持一行：曾因列宽被挤压成"运行/中"两行（#5）。
   设为 nowrap 并给最小宽度，宁可让"绑定"列换行，也不让状态药丸断行。 */
.dim-lt-statusCell { white-space: nowrap; }
.dim-lt-statusCell .dim-lt-pill { white-space: nowrap; }
.dim-lt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
/* 药丸**不可被压缩**：否则同行出现长文本时（如"未配置凭据，请先登录"），
   flex 会把药丸挤成竖排单字（实测："未知"竖成两行、"不支持"竖成三行）。 */
.dim-lt-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); color: var(--dsw-alias-label-secondary, #555); flex-shrink: 0; white-space: nowrap; }
/* 能力/结果行的首列标签（如"工具调用"）同样不可压缩 */
.dim-lt-cap > span:first-child { flex-shrink: 0; }
.dim-lt-pillOn { border-color: color-mix(in srgb, #389e0d 45%, transparent); color: #389e0d; background: color-mix(in srgb, #389e0d 8%, transparent); }
.dim-lt-pillOff { border-color: color-mix(in srgb, #8a8f99 40%, transparent); color: #8a8f99; }
.dim-lt-pillWarn { border-color: color-mix(in srgb, #d46b08 45%, transparent); color: #d46b08; background: color-mix(in srgb, #d46b08 8%, transparent); }
.dim-lt-notice { padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); font-size: 12.5px; line-height: 1.6; margin-bottom: 10px; }
.dim-lt-noticeInfo { border-color: color-mix(in srgb, #1677ff 32%, transparent); background: color-mix(in srgb, #1677ff 6%, transparent); }
.dim-lt-noticeWarn { border-color: color-mix(in srgb, #d46b08 38%, transparent); background: color-mix(in srgb, #d46b08 7%, transparent); color: #d46b08; }
.dim-lt-noticeError { border-color: color-mix(in srgb, #d4380d 38%, transparent); background: color-mix(in srgb, #d4380d 6%, transparent); color: #d4380d; }
.dim-lt-noticeOk { border-color: color-mix(in srgb, #389e0d 38%, transparent); background: color-mix(in srgb, #389e0d 6%, transparent); color: #389e0d; }
/* 就地反馈行（放在产生操作的位置下方，而不是页面顶部） */
.dim-lt-inline { font-size: 12.5px; line-height: 1.6; margin-top: 8px; }
.dim-lt-inlineOk { color: #389e0d; }
.dim-lt-inlineErr { color: #d4380d; word-break: break-word; }
.dim-lt-inlineWarn { color: #d46b08; }
/* 操作行：在对应条目下方均匀分布 */
.dim-lt-actions { display: flex; gap: 8px; }
.dim-lt-actions > .dim-lt-btn { flex: 1 1 0; text-align: center; }
/* 临时弹窗（自建遮罩层；DSH 无原生 modal 插槽） */
.dim-lt-modalMask { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgb(0 0 0 / 32%); padding: 24px; }
.dim-lt-modalCard { width: min(560px, 100%); max-height: 80vh; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 18px 48px rgb(0 0 0 / 18%); padding: 18px 20px; }
.dim-lt-modalTitle { margin: 0 0 6px; font-size: 15px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-lt-modalHint { margin: 0 0 12px; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-modalFoot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.dim-lt-keyBox { display: flex; gap: 8px; align-items: center; }
/* 用量概览小卡片 */
/* #228：section 内的子标题（合并多块内容时用） */
      .dim-lt-subTitle { font-size: 13px; font-weight: 640; color: var(--dsw-alias-label-secondary, #555); margin: 14px 0 6px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3); }
      /* #228：可折叠 section（原生 details/summary）。默认收起，点标题展开。 */
      .dim-lt-section.collapsible { padding-top: 0; }
      .dim-lt-section.collapsible > summary { cursor: pointer; list-style: none; padding: 12px 0 10px; margin: 0; display: flex; align-items: center; gap: 7px; user-select: none; }
      .dim-lt-section.collapsible > summary::-webkit-details-marker { display: none; }
      .dim-lt-section.collapsible > summary::before { content: '▸'; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8f99); transition: transform .12s ease; }
      .dim-lt-section.collapsible[open] > summary::before { content: '▾'; }
      .dim-lt-section.collapsible > summary:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
      .dim-lt-section.collapsible[open] { padding-bottom: 12px; }
      .dim-lt-miniStat { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 10px; padding: 6px 12px; min-width: 96px; }
.dim-lt-miniStatK { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dim-lt-miniStatV { font-size: 16px; font-weight: 640; margin-top: 1px; font-variant-numeric: tabular-nums; }
      /* #228：卡片副标题（环比）。比主值小一号、弱一档，不抢主信息。 */
      .dim-lt-miniStatSub { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a8f99); margin-top: 2px; font-variant-numeric: tabular-nums; }
.dim-lt-keyBox > .dim-lt-input { flex: 1; min-width: 0; }
.dim-lt-model { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
.dim-lt-modelHead { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; background: none; border: none; font: inherit; font-size: 13px; color: inherit; cursor: pointer; text-align: left; }
.dim-lt-modelHead:hover { background: color-mix(in srgb, #1677ff 4%, transparent); }
/* 模型名与「展开/收起」互不让位：#8 的"▾ 展开"曾被挤成"▾ 展 / 开"两行。
   让主标题可收缩换行，右侧动作按钮保持一行。 */
.dim-lt-modelHead > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.dim-lt-modelTitle { min-width: 0; overflow-wrap: anywhere; }
.dim-lt-nowrap { white-space: nowrap; }
.dim-lt-modelBody { padding: 10px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3); }
.dim-lt-caps { display: grid; gap: 6px; margin-bottom: 12px; }
.dim-lt-cap { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
/* 说明文本可换行、可在长 token 内断行，避免撑破容器 */
.dim-lt-capSrc { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); overflow-wrap: anywhere; }
.dim-lt-checkbox { accent-color: #1677ff; }
.dim-lt-green { color: #389e0d; font-size: 12.5px; }
.dim-lt-red { color: #d4380d; font-size: 12.5px; word-break: break-all; }
.dim-lt-muted { color: var(--dsw-alias-label-tertiary, #8a8f99); font-size: 12px; }
.dim-lt-spin { display: inline-block; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, #1677ff 30%, transparent); border-top-color: #1677ff; border-radius: 50%; animation: dim-lt-rot .7s linear infinite; vertical-align: -1px; margin-right: 6px; }
@keyframes dim-lt-rot { to { transform: rotate(360deg); } }
.dim-lt-empty { padding: 26px 16px; text-align: center; color: var(--dsw-alias-label-tertiary, #8a8f99); font-size: 13px; }
.dim-lt-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.dim-lt-kv dt { color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-kv dd { margin: 0; }
.dim-lt-ext { font-size: 10px; line-height: 1; margin-left: 3px; vertical-align: 2px; }

/* ── 自定义模型（虚拟名 + 故障转移链）── */
/* 品牌区块：容器本身不设样式，但保留类名钩子，便于将来整体加背景/留白 */
.dim-lt-brand { min-width: 0; }
/* 左栏强调入口（自定义模型）：与普通 provider 按钮区分开，
   用左侧竖条 + 淡蓝底提示"这是功能入口，不是一个 provider" */
.dim-lt-navAccent { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); }
.dim-lt-navAccent .dim-lt-navIcon { background: color-mix(in srgb, #1677ff 16%, transparent); color: #1677ff; }
.dim-lt-navAccent[aria-selected="true"] { box-shadow: inset 3px 0 0 0 #1677ff; }
/* 置灰按钮行（已删除的 Key 等）：整行操作按钮降低存在感 */
.dim-lt-actionRow .dim-lt-actions { opacity: .55; }
/* 绑定链容器：竖直排列，行间细线 */
.dim-lt-bindList { display: grid; gap: 6px; }
/* 单条绑定：序号 | 名称 | 操作。
   名称列 minmax(0,1fr) 让长模型名能省略号截断，不把按钮挤出去。 */
.dim-lt-bindRow { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-layer-3, #fff); }
.dim-lt-bindOrder { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px; background: color-mix(in srgb, #1677ff 9%, transparent); color: #1677ff; font-size: 11px; font-weight: 640; font-variant-numeric: tabular-nums; }
.dim-lt-bindName { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 名称本身必须可截断：模型公开名常有 30+ 字符 */
.dim-lt-bindName > .dim-lt-mono { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-lt-bindOps { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
/* 图标按钮（↑ ↓ ✕）：方形、紧凑，disabled 时明显变淡 */
.dim-lt-iconBtn { width: 22px; height: 22px; padding: 0; display: grid; place-items: center; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 6px; background: var(--dsw-alias-bg-layer-3, #fff); color: inherit; font: inherit; font-size: 11px; line-height: 1; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
.dim-lt-iconBtn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, #1677ff 5%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-iconBtn:disabled { opacity: .3; cursor: not-allowed; }
.dim-lt-iconBtnDanger { color: #d4380d; }
.dim-lt-iconBtnDanger:hover:not(:disabled) { border-color: color-mix(in srgb, #d4380d 45%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, #d4380d 6%, var(--dsw-alias-bg-layer-3, #fff)); }
`

    /** 只安装一次样式表。 */
    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled) return () => {}
      const tagId = 'dsh-lantern/styles'
      if (document.querySelector(`style[data-plugin-style="${tagId}"]`) !== null) {
        stylesInstalled = true
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.pluginStyle = tagId
      style.textContent = STYLES
      document.head.appendChild(style)
      stylesInstalled = true
      return () => {
        style.remove()
        stylesInstalled = false
      }
    }

    // ────────────────────────────── 小组件 ──────────────────────────────

    const h = React.createElement

    /** 一条键值展示。 */
    function Kv(props) {
      return h('div', { className: cx('kv') }, [
        h('dt', { key: 'k' }, props.label),
        h('dd', { key: 'v' }, props.children),
      ])
    }

    /** 状态药丸。 */
    function Pill(props) {
      const tone = props.tone === 'on' ? 'pillOn' : props.tone === 'warn' ? 'pillWarn' : props.tone === 'off' ? 'pillOff' : ''
      // #225：支持 title —— 状态标签常常需要一句解释（比如「已失效」到底指什么），
      // 而标签本身字数有限，解释只能放悬停里。
      // 之前没透传，调用方写的 title 会被静默丢掉（写了等于没写）。
      const extra = props.title === undefined ? {} : { title: props.title }
      return h('span', { className: cx('pill', tone), ...extra }, props.children)
    }

    /** token 数 → M（3 位小数）。 */
    const fmtMTokens = (n) => (Number(n ?? 0) / 1_000_000).toFixed(3)

    /** 调用类型标签（与报告口径一致）。 */
    const KIND_LABEL = { inference: '推理调用', test: '功能测试', perf: '性能测试' }

    /** 概览小卡片。`raw=true` 时直接显示字符串（如命中率）。 */
    function MiniStat(props) {
      const { label, value, raw = false, sub } = props
      return h(
        'div',
        { className: cx('miniStat') },
        h('div', { className: cx('miniStatK') }, label),
        h('div', { className: cx('miniStatV') }, raw ? value : `${value}`),
        // #228：副标题（用于环比这类附加信息）。空则不占位。
        sub === undefined || sub === null ? null : h('div', { className: cx('miniStatSub') }, sub),
      )
    }

    /** 提示条。 */
    function Notice(props) {
      if (!props.children) return null
      const tone =
        props.tone === 'warn' ? 'noticeWarn' : props.tone === 'error' ? 'noticeError' : props.tone === 'ok' ? 'noticeOk' : 'noticeInfo'
      return h('div', { className: cx('notice', tone) }, props.children)
    }

    /**
     * 就地反馈行：显示在**产生操作的位置下方**，而不是页面顶部。
     * 顶部反馈在长页面里几乎看不到（用户实测反馈），故统一改成就地显示。
     * @param props - `{ notice }`，notice 为 `{ tone, text }` 或 null。
     */
    function Inline(props) {
      const notice = props.notice
      if (!notice || !notice.text) return null
      const tone = notice.tone === 'error' ? 'inlineErr' : notice.tone === 'warn' ? 'inlineWarn' : 'inlineOk'
      return h('div', { className: cx('inline', tone) }, notice.text)
    }

    /**
     * 临时弹窗（自建遮罩层）。
     *
     * DSH 没有原生 modal 插槽（已查：`settings.*` 插槽只有 section/item/tab 等），
     * 因此这里用 `position: fixed` 的遮罩 + 卡片自行实现，效果与设置窗口同层。
     * 用途：展示"只显示一次"的 API Key（顶部反馈看不见，用户实测反馈）。
     *
     * @param props - `{ title, hint, children, footer, onClose }`。
     */
    function Modal(props) {
      const { title, hint, children, footer, onClose } = props
      // Esc 关闭
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onClose?.()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: cx('modalMask'),
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (e) => {
            if (e.target === e.currentTarget) onClose?.()
          },
        },
        h(
          'div',
          { className: cx('modalCard') },
          title ? h('h3', { className: cx('modalTitle') }, title) : null,
          hint ? h('p', { className: cx('modalHint') }, hint) : null,
          children,
          h(
            'div',
            { className: cx('modalFoot') },
            footer ?? h('button', { className: cx('btn'), onClick: onClose }, '关闭'),
          ),
        ),
      )
    }

    // ────────────────────────────── 状态与安全页 ──────────────────────────────

    function StatusPage(props) {
      const { rpc } = props
      const [status, setStatus] = React.useState(null)
      const [keys, setKeys] = React.useState([])
      const [listens, setListens] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [newKey, setNewKey] = React.useState(null)
      const [keyLabel, setKeyLabel] = React.useState('')
      // #228：Key 列表的搜索与排序 —— Key 多了（>10 个）之后找起来很费劲。
      // 搜索匹配 label 或指纹（指纹常用来区分同名 Key）。
      const [keyQuery, setKeyQuery] = React.useState('')
      const [keySort, setKeySort] = React.useState('recent') // recent | created | label
      // #234：Key 批量操作 —— 多选后一次停用/启用/删除。
      // 用 Set 存 id（增删都是 O(1)，且不用关心顺序）。
      const [selectedKeys, setSelectedKeys] = React.useState(() => new Set())
      const toggleKeySel = (id) => setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      const [draft, setDraft] = React.useState(null)
      const [usage, setUsage] = React.useState(null)
      // #231：是否显示"已删除的 Key / 已下线的模型"的历史用量。
      // 默认不显示 —— 它们占着 Token 排行会误导"现在还在用"；
      // 但账本是流水，历史不该抹掉，所以给一个开关按需展开。
      const [showStale, setShowStale] = React.useState(false)
      // #235：汇总口径 —— 0 = "本月当期"（原行为），其余 = "最近 N 天"。
      // 只影响表格汇总，不影响"今日/本周/本月/今年"四张卡（那是固定口径）。
      const [usageRange, setUsageRange] = React.useState(0)
      const [breaker, setBreaker] = React.useState(null)
      // 后端健康记忆（m04349）：冷却中/已恢复的后端一栏。
      // 初始 undefined 而不是 null——「还没读到」与「读到了但是没有记录」要能分开，
      // 否则面板一开就报「全部健康」，其实根本没问过网关。
      const [backendHealth, setBackendHealth] = React.useState(undefined)
      // #238：数据目录状态 —— 位置、各文件是否就绪、旧目录残留。
      // undefined = 还没读到（与"读到了但为空"区分）。
      const [storage, setStorage] = React.useState(undefined)
      const [filters, setFilters] = React.useState(null)
      const [filterDraft, setFilterDraft] = React.useState({ providers: '', models: '', allowedModels: '' })
      const [cors, setCors] = React.useState(null)
      const [corsOrigins, setCorsOrigins] = React.useState('')
      // 对外措辞开关：默认全藏（面向客户的网关不该把 provider 名喊出来）
      const [exposure, setExposure] = React.useState(null)

      // `rpc` 每次渲染都是新引用 → 用 ref 稳定，避免 effect 反复重跑。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      /** 读熔断状态（P12）：冷却剩余时间在 UI 里要能实时看到。 */
      const loadBreaker = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('breaker/status', {})
          setBreaker(r)
        } catch {
          /* 面板仍可用 */
        }
      }, [])

      /** 读后端健康记忆（m04349）：哪个后端刚失败过、还剩几秒冷却。 */
      const loadBackendHealth = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('backendHealth/status', {})
          setBackendHealth(r)
        } catch {
          /* 面板仍可用；区块会停在"状态读取中…" */
        }
      }, [])

      /**
       * #238：读数据目录状态。
       *
       * 独立成一个 loader 而不是塞进 refresh：这样"生成 Key 之后"
       * 可以只刷新这一块，让「文件」列立刻从「缺失」变成有大小。
       */
      const loadStorage = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('storage/status', {})
          setStorage(r)
        } catch {
          /* 面板仍可用；区块会显示"读取中" */
        }
      }, [])

      /** 读过滤配置与"实际生效"的结果（P16）。 */
      const loadFilters = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('filters/get', {})
          setFilters(r)
          setFilterDraft({
            providers: (r.filters?.providers ?? []).join('\n'),
            models: (r.filters?.models ?? []).join('\n'),
            allowedModels: (r.filters?.allowedModels ?? []).join('\n'),
          })
        } catch {
          /* 面板仍可用 */
        }
      }, [])

      /**
       * 读跨域配置（CORS）。
       *
       * 单独取一次而不是塞进 config/get：cors 是**开门器**，服务端也给它
       * 单独一组 RPC（cors/get、cors/set），这里保持一致。
       */
      const loadCors = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('cors/get', {})
          setCors(r?.cors ?? null)
          setCorsOrigins((r?.cors?.allowOrigins ?? []).join('\n'))
        } catch {
          /* 面板仍可用 */
        }
      }, [])

      /** 读对外措辞开关（脱敏）。与 cors 同属「对外行为」，单独一组 RPC。 */
      const loadExposure = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('exposure/get', {})
          setExposure(r?.exposure ?? null)
        } catch {
          /* 面板仍可用 */
        }
      }, [])
      /** 读用量概览（卡片 + 按 Key + 按类型）。 */
      const loadUsage = React.useCallback(async () => {
        try {
          const u = await rpcRef.current('usage/summary', {
            granularity: 'monthly',
            // #235：0 = 本月当期（原行为），N = 最近 N 天
            ...(usageRange > 0 ? { rangeDays: usageRange } : {}),
          })
          const daily = await rpcRef.current('usage/summary', { granularity: 'daily' })
          const yearly = await rpcRef.current('usage/summary', { granularity: 'yearly' })
          const weekly = await rpcRef.current('usage/summary', { granularity: 'weekly' })
          const M = (n) => (Number(n ?? 0) / 1_000_000).toFixed(3)
          // #228：本月环比。匿名函数里算一次，null 表示"没有上月数据可比"。
          const momDelta = (() => {
            const prev = u.prevMonth
            if (prev === undefined || prev === null) return null
            if (prev.total <= 0) return null
            const cur = Number(u.totals.total ?? 0)
            return (cur - prev.total) / prev.total
          })()
          setUsage({
            totals: u.totals,
            keys: u.keys ?? [],
            kinds: u.kinds ?? [],
            models: u.models ?? [],
            modelCount: u.modelCount,
            cross: u.cross ?? [],
            requested: u.requested ?? [],
            monthDailyAvg: u.monthDailyAvg,
            rangeDays: u.rangeDays ?? null,
            rangeFrom: u.rangeFrom,
            rangeTo: u.rangeTo,
            modelTrends: u.modelTrends ?? {},
            empty: u.empty,
            cards: {
              today: M(daily.totals.total),
              week: M(weekly.totals.total),
              month: M(u.totals.total),
              year: M(yearly.totals.total),
              monthTrend: momDelta,
              prevMonthKey: u.prevMonth?.key,
              hitRate: u.totals.hitRate === null ? '—' : `${(u.totals.hitRate * 100).toFixed(1)}%`,
            },
          })
        } catch (error) {
          setNotice({ tone: 'error', text: `读取用量失败：${error.message}`, where: 'usage' })
        }
      }, [usageRange])

      const refresh = React.useCallback(async () => {
        try {
          const s = await rpcRef.current('status', {})
          setStatus(s)
          const k = await rpcRef.current('keys/list', {})
          setKeys(k.keys ?? [])
          const l = await rpcRef.current('listen/list', {})
          setListens(l.entries ?? [])
          // 注意：**不清空 draft** —— 否则用户正在编辑的端口表单会被刷新冲掉。
        } catch (error) {
          setNotice({ tone: 'error', text: `读取状态失败：${error.message}`, where: 'overview' })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        void loadUsage()
        void loadBreaker()
        void loadBackendHealth()
        void loadFilters()
        void loadCors()
        void loadExposure()
        void loadStorage()
        // 熔断状态每 5 秒刷一次（冷却倒计时要实时）；
        // 后端健康记忆的冷却倒计时同理——它跟熔断是两套独立的状态。
        const t = setInterval(() => {
          void loadBreaker()
          void loadBackendHealth()
        }, 5000)
        return () => clearInterval(t)
      }, [refresh, loadUsage, loadBreaker, loadBackendHealth, loadFilters, loadCors, loadStorage])

      /**
       * 统一包装一次操作：忙态 + **就地提示** + 刷新。
       * `where` 决定反馈显示在哪个分组下方（顶部反馈在长页面里看不见）。
       * @param where - `'svc' | 'listen' | 'keys' | 'limits' | 'diag' | 'image'`。
       */
      const run = async (fn, okText, where = 'keys') => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          if (okText) setNotice({ tone: 'ok', text: okText, where })
          await refresh()
        } catch (error) {
          setNotice({ tone: 'error', text: error.message, where })
        } finally {
          setBusy(false)
        }
      }

      /** 取某分组绑定的就近提示。 */
      const noticeAt = (where) => (notice && notice.where === where ? notice : null)

      if (status === null) {
        return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取中…')
      }

      const cfg = status.config ?? {}
      const limits = cfg.limits ?? {}
      const auth = cfg.auth ?? {}

      return h('div', null, [
        // ⚠ 兜底渲染：有些提示不属于任何分组（刷新失败、剪贴板失败…），
        // 而全页每个提示位都用 noticeAt(where) 取，不带 where 的 notice
        // 永远没人渲染——用户点了按钮看不到任何反应。这里把「没有 where」的
        // 提示统一显示在顶部。
        notice !== null && notice.where === undefined
            ? h(Notice, { key: 'globalNotice', tone: notice.tone }, notice.text)
          : null,
        // ── 「只显示一次」的 API Key：用临时弹窗展示（顶部/内联都容易被忽略）──
        newKey
          ? h(
              Modal,
              {
                key: 'newkey',
                // #227：不再说"只显示这一次" —— 明文已持久化，随时能回来看。
                title: `API Key${newKey.label ? ' · ' + newKey.label : ''}`,
                hint: '明文已保存，之后随时可以在列表里点「查看」再复制。',
                onClose: () => setNewKey(null),
                footer: h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    {
                      className: cx('btn', 'btnPrimary'),
                      onClick: () => {
                        void navigator.clipboard?.writeText(newKey.plaintext)
                        setNotice({ tone: 'ok', text: '已复制到剪贴板', where: 'keys' })
                      },
                    },
                    '复制',
                  ),
                  h('button', { className: cx('btn'), onClick: () => setNewKey(null) }, '我已保存，关闭'),
                ),
              },
              h(
                'div',
                { className: cx('keyBox') },
                h('input', {
                  className: cx('input', 'mono'),
                  readOnly: true,
                  value: newKey.plaintext,
                  onFocus: (e) => e.target.select(),
                }),
              ),
            )
          : null,

        // 服务开关
        h(
          'div',
          { key: 'svc', className: cx('section') },
          h(
            'h3',
            { className: cx('sectionTitle') },
            '服务开关',
            h(Pill, { tone: cfg.enabled ? 'on' : 'off' }, cfg.enabled ? '运行中' : '已停止'),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            '关闭后所有局域网请求返回 503，且不消耗任何上游额度。插件默认关闭。',
          ),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(
                    () => rpc('config/set', { config: { enabled: !cfg.enabled } }),
                    cfg.enabled ? '已停止服务' : '已启用服务',
                    'svc',
                  ),
              },
              cfg.enabled ? '停止服务' : '启用服务',
            ),
            h(
              'span',
              { className: cx('muted') },
              `当前并发 ${status.inflight} / ${limits.maxConcurrent ?? 2}`
            ),
          ),
          h(Inline, { notice: noticeAt('svc') }),
        ),

        // 监听与端口
        h(
          'details',
          { key: 'listen', className: cx('section', 'collapsible'), open: undefined },
          h(
            'summary',
            { className: cx('sectionTitle') },
            '监听与端口',
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                // #228：这个按钮在 <summary> 里面（标题行右侧），
                // 浏览器会把点击也当成"切换折叠" → 点「添加端口」会把面板合上。
                // 必须显式阻止冒泡，否则行为很怪。
                onClick: (ev) => {
                  ev.preventDefault()
                  ev.stopPropagation()
                  const first = listens[0]
                  setDraft({
                    mode: 'standalone',
                    bind: '0.0.0.0',
                    port: 3081,
                    // reuse 只能有一条：已有 reuse 时默认仍给 standalone
                    allowReuse: !listens.some((e) => e.mode === 'reuse'),
                    basedOn: first ? first.id : null,
                  })
                },
              },
              '+ 添加端口',
            ),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            'standalone：绑定地址由插件决定（推荐）。reuse：复用 DSH 端口，地址由 DSH 的 --host 决定。',
          ),
          listens.length === 0
            ? h('div', { className: cx('empty') }, '暂无监听条目')
            : h(
                'table',
                { className: cx('table') },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '模式'),
                    h('th', null, '绑定'),
                    h('th', null, '端口'),
                    h('th', null, '状态'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  listens.flatMap((entry) => {
                    const active = (status.listen ?? []).find((x) => x.id === entry.id)
                    // 第 1 行：信息 + 状态（状态独占末列，空间充足，不再被按钮挤成竖排）
                    const infoRow = h(
                      'tr',
                      { key: `${entry.id}-info` },
                      h('td', null, entry.mode === 'reuse' ? 'reuse' : 'standalone'),
                      // 绑定地址：显示**实际生效**的地址（而非配置值）。
                      // reuse 下该地址由 DSH 的 --host 决定、插件无权修改
                      //（曾误显示配置值 0.0.0.0 → 用户以为局域网可访问，实际只有回环）。
                      //
                      // ⚠ 说明一律走 ⓘ 图标 + 悬停（同"已删除 Key"的做法）：
                      // 曾经把"继承自 DSH（配置的 0.0.0.0 未生效）"整行写在地址下方，
                      // 会把本该很短的地址列撑高、挤占版面（用户实测反馈）。
                      h(
                        'td',
                        { className: cx('mono', 'bindCell') },
                        h('span', { className: cx('nowrap') }, active?.bind ?? entry.bind),
                        active?.bindInherited
                          ? h(
                              'span',
                              {
                                className: cx('infoIcon'),
                                title:
                                  `继承自 DSH：reuse 复用 DSH 的监听端口，绑定地址由 DSH 启动参数 --host 决定，本插件无权修改。\n` +
                                  (active?.requestedBind && active.requestedBind !== active.bind
                                    ? `插件里配置的是 ${active.requestedBind}，实际生效的是 ${active.bind}。\n`
                                    : '') +
                                  '要自定义绑定地址：改用 standalone 模式，或让 DSH 以 --host 0.0.0.0 启动。',
                                'aria-label': '继承自 DSH（悬停查看说明）',
                              },
                              'ⓘ',
                            )
                          : null,
                      ),
                      h('td', { className: cx('mono', 'nowrap') }, String(entry.mode === 'reuse' ? (active?.port ?? '—') : entry.port)),
                      h(
                        'td',
                        { className: cx('statusCell') },
                        active?.listening
                          ? h(Pill, { tone: 'on' }, '运行中')
                          : h(Pill, { tone: entry.enabled === false ? 'off' : 'warn' }, entry.enabled === false ? '已停用' : '未启动'),
                        active?.error ? h('div', { className: cx('muted') }, active.error) : null,
                      ),
                    )
                    // 第 2 行：三个操作按钮横跨整行、均匀分布
                    const actionRow = h(
                      'tr',
                      { key: `${entry.id}-actions`, className: cx('actionRow') },
                      h(
                        'td',
                        { colSpan: 4 },
                        h(
                          'div',
                          { className: cx('actions') },
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () => setDraft({ ...entry, editing: true }),
                            },
                            '编辑',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () =>
                                run(
                                  () => rpc('listen/update', { action: 'update', id: entry.id, entry: { enabled: entry.enabled === false } }),
                                  entry.enabled === false ? '已启用该条目' : '已停用该条目',
                                  'listen',
                                ),
                            },
                            entry.enabled === false ? '启用' : '停用',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn', 'btnDanger'),
                              disabled: busy || listens.length <= 1,
                              title: listens.length <= 1 ? '不能删除最后一条（否则等于把自己关停）' : '',
                              onClick: () => {
                                if (!window.confirm('删除该监听条目？删除后该端口立即停止服务。')) return
                                void run(() => rpc('listen/update', { action: 'remove', id: entry.id }), '已删除', 'listen')
                              },
                            },
                            '删除',
                          ),
                        ),
                      ),
                    )
                    return [infoRow, actionRow]
                  }),
                ),
              ),
          h(Inline, { notice: noticeAt('listen') }),
        ),

        // 端口编辑表单
        draft
          ? h(
              'div',
              { key: 'draft', className: cx('section'), style: { borderColor: '#1677ff' } },
              h('h3', { className: cx('sectionTitle') }, draft.editing ? '编辑监听条目' : '新增监听条目'),
              h(
                'div',
                { className: cx('row') },
                h(
                  'label',
                  { className: cx('field') },
                  h('span', { className: cx('fieldLabel') }, '模式'),
                  h(
                    'select',
                    {
                      className: cx('select'),
                      value: draft.mode,
                      onChange: (e) => setDraft({ ...draft, mode: e.target.value }),
                    },
                    h('option', { value: 'standalone' }, 'standalone（推荐）'),
                    draft.editing || draft.allowReuse ? h('option', { value: 'reuse' }, 'reuse（复用 DSH 端口）') : null,
                  ),
                ),
                h(
                  'label',
                  { className: cx('field') },
                  h('span', { className: cx('fieldLabel') }, '绑定地址'),
                  h(
                    'select',
                    {
                      className: cx('select'),
                      value: draft.bind,
                      // reuse 模式下这个值**不参与实际绑定**（地址继承自 DSH），
                      // 因此禁用它，避免用户以为"选了 0.0.0.0 就真的暴露到局域网了"。
                      disabled: draft.mode === 'reuse',
                      title:
                        draft.mode === 'reuse'
                          ? 'reuse 模式的绑定地址由 DSH 启动参数 --host 决定，本插件无权修改'
                          : '',
                      onChange: (e) => setDraft({ ...draft, bind: e.target.value }),
                    },
                    h('option', { value: '0.0.0.0' }, '0.0.0.0（局域网可访问）'),
                    h('option', { value: '127.0.0.1' }, '127.0.0.1（仅本机）'),
                  ),
                  draft.mode === 'reuse'
                    ? h('span', { className: cx('capSrc') }, '⚠ reuse 下此项不生效')
                    : null,
                ),
                draft.mode === 'standalone'
                  ? h(
                      'label',
                      { className: cx('field') },
                      h('span', { className: cx('fieldLabel') }, '端口'),
                      h('input', {
                        className: cx('input'),
                        type: 'number',
                        min: 1,
                        max: 65535,
                        value: draft.port ?? 3081,
                        onChange: (e) => setDraft({ ...draft, port: Number(e.target.value) }),
                      }),
                    )
                  : null,
              ),
              // 「试听」单独一行（原来与端口输入框同行会错位），结果**在其下方**就地显示
              draft.mode === 'standalone'
                ? h(
                    'div',
                    { style: { marginTop: '10px' } },
                    h(
                      'button',
                      {
                        className: cx('btn'),
                        disabled: busy,
                        onClick: async () => {
                          setBusy(true)
                          setNotice(null)
                          try {
                            const probe = await rpc('listen/probe', { port: draft.port, bind: draft.bind })
                            setNotice(
                              probe.available
                                ? { tone: 'ok', text: `端口 ${draft.port} 可用`, where: 'probe' }
                                : { tone: 'warn', text: `端口 ${draft.port} 不可用：${probe.reason}`, where: 'probe' },
                            )
                          } catch (error) {
                            setNotice({ tone: 'error', text: error.message, where: 'probe' })
                          } finally {
                            setBusy(false)
                          }
                        },
                      },
                      '试听',
                    ),
                    h(Inline, { notice: noticeAt('probe') }),
                  )
                : null,
              h(
                'div',
                { className: cx('row'), style: { marginTop: '10px' } },
                h(
                  'button',
                  {
                    className: cx('btn', 'btnPrimary'),
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        const entry = { mode: draft.mode, bind: draft.bind }
                        if (draft.mode === 'standalone') entry.port = draft.port
                        if (draft.enabled !== undefined) entry.enabled = draft.enabled
                        if (draft.editing) await rpc('listen/update', { action: 'update', id: draft.id, entry })
                        else await rpc('listen/update', { action: 'add', entry })
                        // ⚠ 必须显式传 where：`run()` 的默认值是 `'keys'`，
                        // 不传就会把"端口冲突"这类**监听相关**的错误渲染进 API Key 框体里，
                        // 用户根本看不到（实测发现）。
                      }, draft.editing ? '已更新' : '已添加', 'draft'),
                  },
                  draft.editing ? '保存' : '添加',
                ),
                h('button', { className: cx('btn'), disabled: busy, onClick: () => setDraft(null) }, '取消'),
              ),
              // 监听条目的提交结果（含"端口冲突"等错误）**就地显示在表单下方**
              h(Inline, { notice: noticeAt('draft') }),
            )
          : null,

        // API Key 管理
        h(
          'div',
          { key: 'keys', className: cx('section') },
          h(
            'h3',
            { className: cx('sectionTitle') },
            'API Key 管理',
            h(
              'div',
              { className: cx('row') },
              h('input', {
                className: cx('input'),
                placeholder: '标签（如：书房台式机）',
                value: keyLabel,
                onChange: (e) => setKeyLabel(e.target.value),
              }),
              h(
                'button',
                {
                  className: cx('btn', 'btnPrimary'),
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      const created = await rpc('keys/create', { label: keyLabel })
                      setNewKey(created)
                      setKeyLabel('')
                      // #238：Key 落盘后立刻刷新数据目录区块，
                      // 让「keys」一栏从「缺失」变成实际大小（用户能确认写成功了）。
                      void loadStorage()
                    }, null),
                },
                '+ 生成 Key',
              ),
            ),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            `key 格式：${auth.format === 'sk-hex' ? 'sk-<32位十六进制>（与 DeepSeek 同构）' : auth.format === 'sk-lantern' ? 'sk-lantern-<43位>' : 'sk-<43位 base64url>'}。`,
            h('br'),
            // #227：Key 改成"生成即永久 + 明文可随时查看"后，说明也跟着简化。
            h('span', null, '· Key 生成即永久，不会过期；明文已保存，随时点该行「查看」复制。'),
            h('br'),
            h('span', null, '· 停用/启用不会改变 Key 本身，客户端无需重新配置。'),
          ),
          // #228：搜索 + 排序 —— Key 多了之后（>10 个）逐个找很费劲。
          // 搜索同时匹配 label 与指纹（指纹常用来区分同名 Key）。
          keys.length > 0
            ? h(
                'div',
                { className: cx('row'), style: { marginTop: '6px', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('input', {
                  className: cx('input'),
                  style: { maxWidth: '220px' },
                  placeholder: '搜索标签 / 指纹…',
                  value: keyQuery,
                  onChange: (e) => setKeyQuery(e.target.value),
                }),
                h(
                  'select',
                  {
                    className: cx('input'),
                    style: { maxWidth: '150px' },
                    value: keySort,
                    onChange: (e) => setKeySort(e.target.value),
                  },
                  h('option', { value: 'recent' }, '最近使用优先'),
                  h('option', { value: 'created' }, '新建优先'),
                  h('option', { value: 'label' }, '按标签字母'),
                ),
                (() => {
                  const q = keyQuery.trim().toLowerCase()
                  const shown = keys
                    .filter((k) => q.length === 0
                      || String(k.label ?? '').toLowerCase().includes(q)
                      || String(k.fingerprint ?? '').toLowerCase().includes(q))
                    .sort((a, b) => {
                      if (keySort === 'label') return String(a.label ?? '').localeCompare(String(b.label ?? ''))
                      if (keySort === 'created') return (b.createdAt ?? 0) - (a.createdAt ?? 0)
                      // recent：用过的时间优先，没用过的排后面（按创建时间兜底）
                      return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
                        || (b.createdAt ?? 0) - (a.createdAt ?? 0)
                    })
                  return h('span', { className: cx('muted') },
                    q.length > 0 ? `匹配 ${shown.length} / ${keys.length} 个` : `共 ${keys.length} 个`)
                })(),
                // #234：批量操作 —— 只在有勾选时出现，避免平时占位。
                selectedKeys.size > 0
                  ? h('span', { className: cx('row'), style: { gap: '6px', alignItems: 'center' } },
                      h('span', { className: cx('muted') }, `已选 ${selectedKeys.size} 个`),
                      h('button', {
                        className: cx('btn'),
                        disabled: busy,
                        title: '把这些 Key 全部启用',
                        onClick: () => run(async () => {
                          for (const id of selectedKeys) await rpc('keys/update', { id, enabled: true })
                          setSelectedKeys(new Set())
                        }, `已启用 ${selectedKeys.size} 个`, 'keys'),
                      }, '批量启用'),
                      h('button', {
                        className: cx('btn'),
                        disabled: busy,
                        title: '把这些 Key 全部停用（客户端会立即被拒）',
                        onClick: () => run(async () => {
                          for (const id of selectedKeys) await rpc('keys/update', { id, enabled: false })
                          setSelectedKeys(new Set())
                        }, `已停用 ${selectedKeys.size} 个`, 'keys'),
                      }, '批量停用'),
                      h('button', {
                        className: cx('btn', 'btnDanger'),
                        disabled: busy,
                        title: '删除这些 Key（不可恢复）',
                        onClick: () => {
                          if (!window.confirm(`删除选中的 ${selectedKeys.size} 个 Key？使用它们的客户端会立即断开。`)) return
                          void run(async () => {
                            for (const id of selectedKeys) await rpc('keys/remove', { id })
                            setSelectedKeys(new Set())
                          }, `已删除 ${selectedKeys.size} 个`, 'keys')
                        },
                      }, '批量删除'),
                      h('button', {
                        className: cx('btn'),
                        disabled: busy,
                        onClick: () => setSelectedKeys(new Set()),
                      }, '取消选择'),
                    )
                  : null,
              )
            : null,
          keys.length === 0
            ? h(Notice, { tone: 'warn' }, '尚无任何 API Key —— 局域网请求将一律被拒。请先生成一个。')
            : (() => {
                // 过滤 + 排序后的列表（搜索为空时等于原顺序按所选维度排）
                const q = keyQuery.trim().toLowerCase()
                const shownKeys = keys
                  .filter((k) => q.length === 0
                    || String(k.label ?? '').toLowerCase().includes(q)
                    || String(k.fingerprint ?? '').toLowerCase().includes(q))
                  .sort((a, b) => {
                    if (keySort === 'label') return String(a.label ?? '').localeCompare(String(b.label ?? ''))
                    if (keySort === 'created') return (b.createdAt ?? 0) - (a.createdAt ?? 0)
                    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
                      || (b.createdAt ?? 0) - (a.createdAt ?? 0)
                  })
                if (shownKeys.length === 0) {
                  return h(Notice, { tone: 'info' }, `没有匹配「${keyQuery}」的 Key。`)
                }
                return h(
                'table',
                { className: cx('table') },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    // #234：全选复选框（只对当前搜索/排序后可见的行生效）
                    h('th', { style: { width: '28px' } },
                      h('input', {
                        className: cx('checkbox'),
                        type: 'checkbox',
                        title: '全选/取消全选（只影响当前列出的 Key）',
                        checked: shownKeys.length > 0 && shownKeys.every((k) => selectedKeys.has(k.id)),
                        onChange: (e) => setSelectedKeys(
                          e.target.checked ? new Set(shownKeys.map((k) => k.id)) : new Set(),
                        ),
                      }),
                    ),
                    h('th', null, '标签'),
                    h('th', null, '指纹'),
                    h('th', null, '创建时间'),
                    h('th', null, '最近使用'),
                    h('th', null, '状态'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  shownKeys.flatMap((k) => {
                    // 第 1 行：信息 + 状态（状态独占末列，不再与按钮挤在一格）
                    const infoRow = h(
                      'tr',
                      { key: `${k.id}-info`, className: cx(selectedKeys.has(k.id) ? 'rowSelected' : null) },
                      // #234：多选列
                      h('td', null,
                        h('input', {
                          className: cx('checkbox'),
                          type: 'checkbox',
                          checked: selectedKeys.has(k.id),
                          onChange: () => toggleKeySel(k.id),
                        }),
                      ),
                      h('td', null, k.label),
                      h('td', { className: cx('mono', 'nowrap') }, k.fingerprint),
                      h('td', { className: cx('muted') }, fmtTime(k.createdAt)),
                      // #235：索引列显示"相对时间"，悬停给绝对时间 ——
                      // 一眼看出"这个 Key 三个月没用过"，想知道具体哪天再悬停。
                      h('td', { className: cx('muted'), title: k.lastUsedAt ? fmtTime(k.lastUsedAt) : '从未使用' },
                        k.lastUsedAt ? fmtAgo(k.lastUsedAt) : '未使用'),
                      h('td', { className: cx('statusCell') },
                        // #227：Key 生成即永久，不再有过期概念。
                        // 原来这里有一支「已过期」判定（轮换后的旧 Key 宽限期结束），
                        // 现在 rotate 已移除，expiresAt 永远不存在，那支是死逻辑。
                        k.enabled ? h(Pill, { tone: 'on' }, '启用') : h(Pill, { tone: 'off' }, '停用'),
                      ),
                    )
                    // 第 2 行：按钮横跨整行、均匀分布
                    const actionRow = h(
                      'tr',
                      { key: `${k.id}-actions`, className: cx('actionRow') },
                      h(
                        'td',
                        { colSpan: 6 },
                        h(
                          'div',
                          { className: cx('actions') },
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () =>
                                run(
                                  () => rpc('keys/update', { id: k.id, enabled: !k.enabled }),
                                  k.enabled ? '已停用' : '已启用',
                                  'keys',
                                ),
                            },
                            k.enabled ? '停用' : '启用',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              // #227：明文现在持久化保存，忘了直接看，客户端配置完全不用动。
                              // 旧版本建的 Key 没有明文（当时只存哈希）—— **不提供"补发"**：
                              // 那等于静默换掉用户正在用的密钥，风险远大于收益
                              // （本轮开发中我就差点因此改掉一个生产 Key）。
                              // 所以禁用并说明清楚，让用户自己决定何时删除重建。
                              disabled: busy || k.hasPlaintext !== true,
                              title:
                                k.hasPlaintext === true
                                  ? '查看这个 Key 的明文（可复制）。Key 不会过期，任何时候都能再看。'
                                  : '这个 Key 是旧版本创建的，当时只保存了哈希、没有保存明文，无法再查看。\n' +
                                    '需要明文的话，删除它并新建一个 —— 新 Key 会保存明文，之后随时可查看。\n' +
                                    '（不会自动替换，以免在你不知情时把正在用的 Key 换掉。）',
                              onClick: () =>
                                run(async () => {
                                  const r = await rpc('keys/reveal', { id: k.id })
                                  setNewKey({ plaintext: r.plaintext, label: k.label })
                                }, null, 'keys'),
                            },
                            k.hasPlaintext === true ? '查看' : '查看（旧版无明文）',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              // #228：一步复制 —— 不在弹窗里多点一次。
                              // 对没有明文的旧 Key 不可用（同一理由：不静默换密钥）。
                              disabled: busy || k.hasPlaintext !== true,
                              title:
                                k.hasPlaintext === true
                                  ? '直接复制明文到剪贴板（不打开弹窗）'
                                  : '旧版本创建的 Key 没有保存明文，无法复制',
                              onClick: () =>
                                run(async () => {
                                  const r = await rpc('keys/reveal', { id: k.id })
                                  try {
                                    await navigator.clipboard.writeText(r.plaintext)
                                    setNotice({ tone: 'ok', text: `已复制「${k.label}」的 Key`, where: 'keys' })
                                  } catch {
                                    // 剪贴板被浏览器拒绝（非 https / 未聚焦）时退回弹窗，
                                    // 让用户手动复制，而不是假装成功。
                                    setNewKey({ plaintext: r.plaintext, label: k.label })
                                    setNotice({ tone: 'warn', text: '浏览器拒绝了剪贴板访问，请手动复制', where: 'keys' })
                                  }
                                }, null, 'keys'),
                            },
                            '复制',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn', 'btnDanger'),
                              disabled: busy,
                              onClick: () => {
                                if (!window.confirm(`删除 Key「${k.label}」？删除后使用该 Key 的客户端将立即断开。`)) return
                                void run(() => rpc('keys/remove', { id: k.id }), '已删除', 'keys')
                              },
                            },
                            '删除',
                          ),
                        ),
                      ),
                    )
                    return [infoRow, actionRow]
                  }),
                ),
                )
              })(),
          h(Inline, { notice: noticeAt('keys') }),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '10px' } },
            h(
              'label',
              { className: cx('cap') },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: auth.allowAnonymous === true,
                disabled: busy,
                onChange: (e) => {
                  if (e.target.checked && !window.confirm('⚠ 允许匿名访问意味着同网段任何人都能使用本机模型额度，且无法按设备追踪。确定开启？')) return
                  void run(() => rpc('keys/setAnonymous', { allow: e.target.checked }), e.target.checked ? '⚠ 已开启匿名访问' : '已关闭匿名访问')
                },
              }),
              '允许匿名访问（不推荐）',
            ),
          ),
        ),

        // 限额
        h(
          'details',
          { key: 'limits', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '限额与并发'),
          h(
            'p',
            { className: cx('sectionHint') },
            '局域网请求与本机共用同一批上游账号额度。这些限额用于保护本机不被拖慢（宁可局域网慢一点）。',
          ),
          h(
            'div',
            { className: cx('row') },
            ...[
              // 上界与服务端 clampInt 保持一致（512）。两边不一致时，面板显示
              // "已保存"而服务端钳成别的值，就成了又一处"设置自己变回去"。
              ['maxConcurrent', '最大并发', 1, 512],
              ['perKeyRpm', '每Key每分钟请求', 1, 100000],
              ['perKeyTpm', '每Key每分钟输出 token', 100, 10000000],
              ['maxTokensCap', '单次 max_tokens 上限', 1, 1000000],
              ['reserveForLocal', '为本机保留并发槽', 0, 63],
            ].map(([field, label, min, max]) =>
              h(
                'label',
                { className: cx('field'), key: field },
                h('span', { className: cx('fieldLabel') }, label),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min,
                  max,
                  // 逐字符写盘有两个坑：清空输入框时 Number('') === 0 会被当成
                  // "允许 0 个"，而 perKeyRpm=0 会让该 Key 每一次请求都 429；
                  // 同时没有 disabled 时连打会产生多个并发的 config/set，后写覆盖先写。
                  // 所以这里只在**失焦或回车**时提交，且空值/非有限值直接不提交。
                  defaultValue: limits[field] ?? '',
                  disabled: busy,
                  onBlur: (e) => {
                    const raw = String(e.target.value ?? '').trim()
                    if (raw.length === 0) { e.target.value = String(limits[field] ?? ''); return }
                    const next = Number(raw)
                    if (!Number.isFinite(next)) { e.target.value = String(limits[field] ?? ''); return }
                    if (next === limits[field]) return
                    void run(() => rpc('config/set', { config: { limits: { [field]: next } } }), null, 'limits')
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                  },
                }),
              ),
            ),
          ),

          // ── 熔断（P12）：保护本机不被局域网刷量拖垮 ──
          h('div', { style: { marginTop: '12px' } },
            h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '熔断保护'),
            h(
              'p',
              { className: cx('sectionHint') },
              '上游连续限流时自动暂停局域网通道（冷却期内的请求立即拒绝、不消耗上游额度），' +
                '等本机缓过来再恢复。本机自己的对话始终不受影响。',
            ),
            // 状态用**行内药丸**表达（#6）：原来是一整行的绿色文本块，
            // 在"熔断保护"标题下孤零零占一行、看起来像排版错误。
            breaker && breaker.open
              ? h('div', { className: cx('row'), style: { marginBottom: '6px' } },
                  h(Pill, { tone: 'warn' }, `已熔断 ${breaker.remainingSec}s`),
                  h('span', { className: cx('capSrc') }, breaker.lastOpenReason ?? ''),
                )
              : h('div', { className: cx('row'), style: { marginBottom: '6px' } },
                  h(Pill, { tone: 'on' }, '正常'),
                  breaker && breaker.consecutiveRateLimits > 0
                    ? h('span', { className: cx('capSrc') }, `当前连续限流 ${breaker.consecutiveRateLimits}/${breaker.threshold}`)
                    : h('span', { className: cx('capSrc') }, '未触发熔断'),
                ),
            h(
              'div',
              { className: cx('row'), style: { marginTop: '6px' } },
              ...([
                ['enabled', '启用熔断', 'checkbox'],
              ]).map(([field, label]) =>
                h('label', { className: cx('cap'), key: field },
                  h('input', {
                    className: cx('checkbox'),
                    type: 'checkbox',
                    checked: limits.breaker?.[field] !== false,
                    disabled: busy,
                    onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { [field]: e.target.checked } } } }), null, 'limits'),
                  }),
                  label,
                ),
              ),
              h('label', { className: cx('field') },
                h('span', { className: cx('fieldLabel') }, '连续限流阈值'),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min: 1,
                  max: 20,
                  value: limits.breaker?.consecutiveRateLimits ?? 3,
                  disabled: busy,
                  onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { consecutiveRateLimits: Number(e.target.value) } } } }), null, 'limits'),
                }),
              ),
              h('label', { className: cx('field') },
                h('span', { className: cx('fieldLabel') }, '冷却秒数'),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min: 5,
                  max: 3600,
                  value: limits.breaker?.cooldownSec ?? 60,
                  disabled: busy,
                  onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { cooldownSec: Number(e.target.value) } } } }), null, 'limits'),
                }),
              ),
              breaker && breaker.open
                ? h('button', {
                    className: cx('btn'),
                    disabled: busy,
                    onClick: () => run(async () => {
                      const r = await rpc('breaker/reset', {})
                      setBreaker(r.after)
                    }, '已解除熔断', 'limits'),
                  }, '立即解除熔断')
                : null,
            ),
            h(Inline, { notice: noticeAt('limits') }),
          ),
        ),

        // 模型与来源过滤（P16 / §4.4 + §7.3）
        h(
          'details',
          { key: 'filters', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '模型与来源过滤'),
          h(
            'p',
            { className: cx('sectionHint') },
            '黑名单命中即不公开；白名单非空时只公开其中的（空 = 全部）。每行一项，' +
              '可写公开名（如 deepseek-v4-pro@buddy）或裸模型名（如 deepseek-v4-pro）。',
          ),
          h(
            'div',
            { className: cx('row'), style: { alignItems: 'flex-start' } },
            ...[
              ['providers', '排除 provider（黑名单）', '每行一个 provider id'],
              ['models', '排除模型（黑名单）', '每行一个模型'],
              ['allowedModels', '只公开这些模型（白名单）', '留空 = 全部'],
            ].map(([field, label, hint]) =>
              h(
                'label',
                { className: cx('field'), key: field, style: { flex: '1 1 200px' } },
                h('span', { className: cx('fieldLabel') }, label),
                h('textarea', {
                  className: cx('input'),
                  rows: 4,
                  placeholder: hint,
                  value: filterDraft[field],
                  disabled: busy,
                  onChange: (e) => setFilterDraft({ ...filterDraft, [field]: e.target.value }),
                  style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' },
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '8px' } },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    const toList = (s) => String(s).split('\n').map((x) => x.trim()).filter((x) => x.length > 0)
                    const r = await rpc('filters/set', {
                      providers: toList(filterDraft.providers),
                      models: toList(filterDraft.models),
                      allowedModels: toList(filterDraft.allowedModels),
                    })
                    await loadFilters()
                    await refresh()
                    setNotice({
                      tone: 'ok',
                      text: `已应用：当前公开 ${r.publicCount} 个模型，过滤掉 ${r.hiddenModelCount} 个`,
                      where: 'filters',
                    })
                  }, null, 'filters'),
              },
              '应用过滤',
            ),
            filters
              ? h('span', { className: cx('muted') },
                  `当前公开 ${filters.publicCount} 个模型` +
                    (filters.hiddenModelCount > 0 ? `，过滤掉 ${filters.hiddenModelCount} 个` : '') +
                    (filters.hiddenProviders?.length > 0 ? `，隐藏 ${filters.hiddenProviders.length} 个 provider` : ''))
              : null,
          ),
          // 实际生效明细：避免"配了过滤器却看不出效果"（设计文档 §4.4.2 的精神）
          filters && filters.hiddenModels?.length > 0
            ? h('details', { style: { marginTop: '6px' } },
                h('summary', { className: cx('muted'), style: { cursor: 'pointer' } },
                  `查看被过滤的 ${filters.hiddenModelCount} 个模型`),
                h('div', { className: cx('caps'), style: { marginTop: '4px' } },
                  filters.hiddenModels.slice(0, 50).map((m) =>
                    h('div', { key: m.publicName, className: cx('cap') },
                      h('span', { className: cx('mono') }, m.publicName),
                      h('span', { className: cx('capSrc') }, m.reason === 'excluded' ? '· 在黑名单' : '· 不在白名单'),
                    ),
                  ),
                  filters.hiddenModelCount > 50
                    ? h('div', { className: cx('muted') }, `… 另有 ${filters.hiddenModelCount - 50} 个`)
                    : null,
                ),
              )
            : null,
          h(Inline, { notice: noticeAt('filters') }),
        ),

        // 协议通道
        h(
          'details',
          { key: 'proto', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '协议通道'),
          h(
            'p',
            { className: cx('sectionHint') },
            'OpenAI 兼容端点 POST /v1/chat/completions（始终开启）；' +
              'Anthropic 兼容端点 POST /v1/messages（可选，供 Claude Code、Cursor 等只认 Anthropic 协议的客户端使用）；' +
              'Responses 兼容端点 POST /v1/responses（可选，供 Codex CLI、OpenAI SDK 等新协议客户端使用）。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cfg.protocol?.anthropic === true,
              disabled: busy,
              onChange: (e) =>
                run(
                  () => rpc('config/set', { config: { protocol: { anthropic: e.target.checked } } }),
                  e.target.checked ? '已开启 Anthropic 兼容端点' : '已关闭 Anthropic 兼容端点',
                  'proto',
                ),
            }),
            '启用 Anthropic 兼容端点（/v1/messages）',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cfg.protocol?.responses === true,
              disabled: busy,
              onChange: (e) =>
                run(
                  () => rpc('config/set', { config: { protocol: { responses: e.target.checked } } }),
                  e.target.checked ? '已开启 Responses 兼容端点' : '已关闭 Responses 兼容端点',
                  'proto',
                ),
            }),
            '启用 Responses 兼容端点（/v1/responses，OpenAI 新协议）',
          ),
          h(
            'p',
            { className: cx('sectionHint'), style: { marginTop: '6px' } },
            '这些端点与 OpenAI 端点共用鉴权、限额、能力闸门与用量记账；' +
              'Anthropic 客户端用 x-api-key 头传 Key（也接受 Authorization: Bearer）；Responses 客户端用 Authorization: Bearer。',
          ),
          h(Inline, { notice: noticeAt('proto') }),
        ),

        // 图片
        h(
          'details',
          { key: 'img', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '图片输入'),
          h(
            'p',
            { className: cx('sectionHint') },
            '图片字节会短暂写入本机附件目录，5 分钟后由插件账本回收。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cfg.allowImageInput === true,
              disabled: busy,
              onChange: (e) => {
                if (e.target.checked && !window.confirm('开启后局域网图片会短暂经过本机磁盘（5 分钟后回收）。继续？')) return
                void run(
                  () => rpc('config/set', { config: { allowImageInput: e.target.checked } }),
                  e.target.checked ? '已开启图片输入' : '已关闭图片输入',
                  'image',
                )
              },
            }),
            '接受图片',
          ),
          // 关闭时的行为等细节放 README；这里只留一行说明
          h('p', { className: cx('sectionHint'), style: { marginTop: '6px' } }, '关闭时（默认）图片请求直接返回 400，且零落盘。'),
          h(Inline, { notice: noticeAt('image') }),
        ),

        // 跨域（CORS）
        // 默认关闭：这是一道开门器，开了之后**任意网页**都能拿用户浏览器里的
        // 身份来打本机网关。所以默认关、并且列表里只认精确来源。
        h(
          'details',
          { key: 'cors', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '跨域（CORS）'),
          h(
            'p',
            { className: cx('sectionHint') },
            '浏览器里的前端（自建控制台、网页版聊天、本地 HTML 工具）直接调本网关时需要它。' +
              '不配的话预检请求会被拒，浏览器只报 Failed to fetch，看不出真实原因。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cors?.enabled === true,
              disabled: busy || cors === null,
              onChange: (e) => {
                const next = e.target.checked
                if (next && (cors?.allowOrigins ?? []).length === 0) {
                  setNotice({
                    tone: 'error',
                    text: '开启跨域前先填写允许的来源（填 * 表示全部放行），再勾选开关',
                    where: 'cors',
                  })
                  return
                }
                if (next && !window.confirm('开启后，下方列出的网站可以在用户浏览器里直接调用本网关。确认来源可信再开启。继续？')) return
                void run(
                  () => rpc('cors/set', { cors: { enabled: next } }),
                  next ? '已开启跨域' : '已关闭跨域',
                  'cors',
                ).then(() => loadCors())
              },
            }),
            '允许浏览器跨域调用',
          ),
          h(
            'div',
            { style: { marginTop: '10px' } },
            h('div', { className: cx('muted'), style: { marginBottom: '4px' } },
              '允许的来源（每行一个，填 * 表示全部放行；不要带路径和末尾斜杠）'),
            h('textarea', {
              className: cx('input'),
              rows: 3,
              placeholder: 'http://localhost:5173\nhttp://192.168.3.20:8080',
              value: corsOrigins,
              disabled: busy || cors === null,
              onChange: (e) => setCorsOrigins(e.target.value),
              style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', width: '100%' },
            }),
          ),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '8px', flexWrap: 'wrap', gap: '10px' } },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy || cors === null,
                onClick: () =>
                  run(
                    async () => {
                      const list = String(corsOrigins)
                        .split('\n')
                        .map((x) => x.trim())
                        .filter((x) => x.length > 0)
                      await rpc('cors/set', { cors: { allowOrigins: list } })
                      await loadCors()
                    },
                    '已保存允许的来源',
                    'cors',
                  ),
              },
              '保存来源',
            ),
            h(
              'label',
              { className: cx('cap'), style: { marginLeft: '4px' } },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: cors?.allowCredentials === true,
                disabled: busy || cors === null,
                onChange: (e) =>
                  void run(
                    () => rpc('cors/set', { cors: { allowCredentials: e.target.checked } }),
                    e.target.checked ? '已允许携带凭证' : '已禁止携带凭证',
                    'cors',
                  ).then(() => loadCors()),
              }),
              '允许携带凭证（cookies）',
            ),
          ),
          cors?.allowOrigins?.includes('*')
            ? h(
                'p',
                { className: cx('sectionHint'), style: { marginTop: '6px', color: 'var(--warn-text, #a15c00)' } },
                '当前是全部放行（*）。浏览器禁止通配符与凭证同时生效，因此「允许携带凭证」在 * 模式下会被忽略。',
              )
            : null,
          h(
            'p',
            { className: cx('sectionHint'), style: { marginTop: '6px' } },
            '服务端只回请求里真实的 Origin，绝不回 *；预检（OPTIONS）免鉴权，' +
              '并会暴露 x-lantern-* 系列响应头，前端能读到降级提示。',
          ),
          h(Inline, { notice: noticeAt('cors') }),
        ),

        // 对外措辞（脱敏）
        // 这是给**客户**看的开关：对外只卖一个聚合模型名，内部有几个 provider、
        // 账号怎么分布，都不该出现在错误响应里。默认全藏。
        h(
          'details',
          { key: 'exposure', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '对外措辞'),
          h(
            'p',
            { className: cx('sectionHint') },
            '控制错误响应里能不能出现内部细节。默认全藏：调用方只看到聚合后的模型名与一句能行动的话。' +
              '关掉之后会原样返回 provider 名、绑定名（xxx@trae）与逐后端失败原因——只适合自己排障时临时打开。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: exposure?.maskTopology !== false,
              disabled: busy || exposure === null,
              onChange: (e) =>
                run(
                  () => rpc('exposure/set', { exposure: { maskTopology: e.target.checked } }),
                  e.target.checked ? '已隐藏内部拓扑' : '已显示内部拓扑（仅排障时用）',
                  'exposure',
                ).then(() => loadExposure()),
            }),
            '隐藏内部拓扑（provider 名、绑定名、逐后端失败原因）',
          ),
          h(
            'label',
            { className: cx('cap'), style: { marginTop: '6px' } },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: exposure?.maskInternalHints !== false,
              disabled: busy || exposure === null,
              onChange: (e) =>
                run(
                  () => rpc('exposure/set', { exposure: { maskInternalHints: e.target.checked } }),
                  e.target.checked ? '已隐藏面板指引' : '已显示面板指引',
                  'exposure',
                ).then(() => loadExposure()),
            }),
            '隐藏面板指引（「设置 → LANtern → …」这类只对管理员有意义的话）',
          ),
          h(
            'p',
            { className: cx('sectionHint'), style: { marginTop: '6px' } },
            '隐藏拓扑时，响应头 X-Lantern-Failover-Chain / -Skipped 只报档数与条数，不报后端名字。',
          ),
          h(Inline, { notice: noticeAt('exposure') }),
        ),
        // 用量统计（P9）
        // ⚠ 这一段必须留在 StatusPage 内：它用的 `usage` / `loadUsage` / `noticeAt('usage')`
        // 都是本组件的状态。曾一度被误放进 ProviderPage，导致点开任意 provider 就抛
        // `ReferenceError: usage is not defined`，React 卸载整棵子树 → **整个面板空白**
        // （用户实测：加/删 provider 黑名单后点左侧 provider 即触发；刷新后回到本页又正常）。
        h(
          'div',
          { key: 'usage', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '用量统计'),
          h(
            'p',
            { className: cx('sectionHint') },
            '只统计经由本插件的调用（不含本机 DSH 自身对话）。功能区分为推理调用、功能测试、性能测试三类，并按每个 API Key 分别统计。' +
            '账本超过上限（默认 16MB）会自动归档，归档部分不进本页统计——这页看的是当前账本的近期用量。',
          ),
          usage === null
            ? h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取用量中…')
            : usage.empty
              ? h(Notice, { tone: 'info' }, '账本还是空的——局域网客户端调用过、或点过「功能测试」之后，这里会出现数据。')
              : h(
                  'div',
                  null,
                  // #235：表格标题用的口径后缀（本月 / 最近 N 天）。
// #235：汇总口径选择器。
                  // 「本月」是原来的固定口径；其余是"最近 N 天"的滚动窗口。
                  // 注意它只影响下面的表格汇总，不影响上面四张卡（那是固定口径）。
                  h(
                    'div',
                    { className: cx('row'), style: { marginBottom: '8px', gap: '8px', alignItems: 'center' } },
                    h('span', { className: cx('muted') }, '汇总口径'),
                    h(
                      'select',
                      {
                        className: cx('input'),
                        style: { maxWidth: '160px' },
                        value: String(usageRange),
                        onChange: (e) => setUsageRange(Number(e.target.value)),
                        title: '只影响下面的表格汇总；上面四张卡是固定口径（当日/当周/当月/当年）',
                      },
                      h('option', { value: '0' }, '本月（当期）'),
                      h('option', { value: '1' }, '最近 1 天'),
                      h('option', { value: '7' }, '最近 7 天'),
                      h('option', { value: '30' }, '最近 30 天'),
                      h('option', { value: '90' }, '最近 90 天'),
                    ),
                    usage.rangeDays !== null && usage.rangeDays !== undefined
                      ? h('span', { className: cx('muted') },
                          `· ${new Date(usage.rangeFrom).toLocaleDateString()} ~ ${new Date(usage.rangeTo).toLocaleDateString()}`)
                      : h('span', { className: cx('muted') }, '· 本月 1 日至今'),
                  ),
                  h(
                    'div',
                    { className: cx('row'), style: { flexWrap: 'wrap', gap: '8px' } },
                    h(MiniStat, { label: '今日', value: usage.cards.today }),
                    h(MiniStat, { label: '本周', value: usage.cards.week }),
                    // #228：本月卡片带上环比（↑12% / ↓5% / 无法比较时不显示）。
                    // #234：环比之外再给一行"日均"，两者一起看能判断
                    // "用量是集中在某一天还是平稳"（环比只有一个总量比值）。
                    h(MiniStat, {
                      label: '本月',
                      value: usage.cards.month,
                      sub: (() => {
                        const parts = []
                        const d = usage.cards.monthTrend
                        if (d !== null && d !== undefined) {
                          parts.push(`${d >= 0 ? '↑' : '↓'}${Math.abs(d * 100).toFixed(0)}% vs 上月`)
                        }
                        const avg = usage.monthDailyAvg
                        if (avg !== undefined && avg !== null) {
                          parts.push(`日均 ${(avg.avg / 1_000_000).toFixed(2)}M`)
                        }
                        return parts.length > 0 ? parts.join(' · ') : undefined
                      })(),
                    }),
                    h(MiniStat, { label: '今年', value: usage.cards.year }),
                    h(MiniStat, { label: '命中率（加权）', value: usage.cards.hitRate, raw: true }),
                    // #224：原来只有"失败"一个计数卡，看不出失败占比。
                    // 合成"请求 / 失败"一张卡，一眼能看出成功率。
                    h(MiniStat, {
                      label: '本月请求 / 失败',
                      value: `${usage.totals.calls ?? 0} / ${usage.totals.failed}`,
                      raw: true,
                    }),
                  ),
                  // #231：默认隐藏"已删除的 Key / 已下线的模型"，一键可展开看历史。
                  // 放在两张表之前（它对两表同时生效），并说明为什么不直接删掉。
                  h(
                    'div',
                    { className: cx('row'), style: { marginTop: '8px', alignItems: 'center', gap: '8px' } },
                    h('label', { className: cx('cap'), title: '账本是追加流水，删除 Key / 下线模型不会抹掉历史行。\n默认把它们藏起来，避免把历史用量误读成"现在还在用"。' },
                      h('input', {
                        className: cx('checkbox'),
                        type: 'checkbox',
                        checked: showStale,
                        onChange: (e) => setShowStale(e.target.checked),
                      }),
                      '显示已删除 / 已下线',
                    ),
                    (() => {
                      const staleKeys = (usage.keys ?? []).filter((k) => k.deleted === true && k.calls > 0).length
                      const staleModels = (usage.models ?? []).filter((m) => m.offline === true).length
                      if (staleKeys === 0 && staleModels === 0) return null
                      return h('span', { className: cx('muted') },
                        `（已删除 Key ${staleKeys} 个 / 已下线模型 ${staleModels} 个，仅历史用量）`)
                    })(),
                  ),
                  // 放在按 Key 之前：模型维度比 Key 维度更常看（Key 一般是自用）。
                  // 只显示 Top 12（服务端已截断），附总模型数供参考。
                  Array.isArray(usage.models) && usage.models.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h(
                          'div',
                          { className: cx('muted'), style: { marginBottom: '4px' } },
                          '按模型（' + (usageRange > 0 ? `最近 ${usageRange} 天` : '本月') + '）' +
                            (typeof usage.modelCount === 'number' && usage.modelCount > usage.models.length
                              ? ` · 前 ${usage.models.length} / 共 ${usage.modelCount} 个`
                              : ''),
                        ),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            // #234：改成按"用户请求的模型名"显示 ——
                            // 不再有"上游"列（一个自定义模型可能跨多个 provider），
                            // 一行一个模型名，跟用户在面板里配的名字一致。
                            h('th', null, '模型'),
                            h('th', null, '调用'),
                            h('th', null, '失败'),
                            h('th', null, '合计 (M)'),
                            h('th', null, '命中率'),
                            // #235：迷你趋势图（最近 12 个时间桶的合计，柱高相对本模型峰值）
                            h('th', { title: '最近 12 个时间桶的用量走势（柱高相对本模型自身峰值）' }, '走势'),
                          )),
                          h('tbody', null, usage.models
                            // #231：默认隐藏已下线模型（历史流水，不代表现在在用）
                            .filter((x) => showStale || x.offline !== true)
                            .map((x) => {
                              const series = usage.modelTrends?.[x.name] ?? []
                              const peak = Math.max(1, ...series.map((s) => s.total ?? 0))
                              return h('tr', { key: x.name, className: cx(x.offline ? 'rowDeleted' : null) },
                                h('td', { title: x.name },
                                  x.name,
                                  x.offline === true
                                    ? h('span', { className: cx('muted'), title: '该模型已不在当前配置里（被删除或改名），此行只是历史用量', style: { marginLeft: '4px' } }, '·已下线')
                                    : null,
                                ),
                                h('td', { className: cx('mono') }, String(x.calls)),
                                h('td', { className: cx('mono') }, String(x.failed ?? 0)),
                                h('td', { className: cx('mono') }, fmtMTokens(x.total)),
                                h('td', { className: cx('mono') }, x.hitRate === null || x.hitRate === undefined ? '—' : `${(x.hitRate * 100).toFixed(1)}%`),
                                h('td', { className: cx('sparkCell') },
                                  series.length === 0
                                    ? h('span', { className: cx('muted') }, '—')
                                    : h('svg', {
                                        width: '72',
                                        height: '18',
                                        viewBox: `0 0 ${Math.max(1, series.length * 6)} 18`,
                                        preserveAspectRatio: 'none',
                                        style: { display: 'block' },
                                      },
                                      series.map((s, i) => {
                                        const h2 = Math.max(1, Math.round(((s.total ?? 0) / peak) * 14))
                                        return h('rect', {
                                          key: `${s.key}-${i}`,
                                          x: i * 6,
                                          y: 18 - h2,
                                          width: '4',
                                          height: String(h2),
                                          fill: x.offline === true ? '#bfbfbf' : '#1677ff',
                                          opacity: 0.85,
                                        }, h('title', null, `${s.key}: ${fmtMTokens(s.total)} M`))
                                      }),
                                    ),
                                ),
                              )
                            })),
                        ),
                      )
                    : null,
                  usage.keys.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '按 API Key（' + (usageRange > 0 ? `最近 ${usageRange} 天` : '本月') + '）'),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            h('th', null, 'Key 名称'),
                            h('th', null, '指纹'),
                            h('th', null, '调用'),
                            h('th', null, '合计 (M)'),
                            h('th', null, '命中率'),
                          )),
                          // #231：默认隐藏已删除的 Key（它们只是历史流水）
                          h('tbody', null, usage.keys
                            .filter((k) => k.calls > 0)
                            .filter((k) => showStale || k.deleted !== true)
                            .map((k) =>
                            h('tr', { key: k.id, className: cx(k.deleted ? 'rowDeleted' : null) },
                              h(
                                'td',
                                { className: cx('keyNameCell') },
                                // Key 名过长时省略号截断 + title 悬停看全名（不再撑宽表格）
                                h('span', { className: cx('ellipsis'), title: k.label }, k.label),
                                // 已删除的 Key：名称旁放一个 ⓘ，悬停才显示注释。
                                // 把"已删除"直接写进名称会撑宽整行（用户实测），故改为图标。
                                k.deleted
                                  ? h('span', {
                                      className: cx('infoIcon'),
                                      title: '该 Key 已删除，此处仅保留其历史用量记录',
                                      'aria-label': '该 Key 已删除',
                                    }, 'ⓘ')
                                  : null,
                              ),
                              h('td', { className: cx('mono', 'nowrap') }, k.fingerprint || '—'),
                              h('td', { className: cx('mono') }, String(k.calls)),
                              h('td', { className: cx('mono') }, fmtMTokens(k.total)),
                              h('td', { className: cx('mono') }, k.hitRate === null ? '—' : `${(k.hitRate * 100).toFixed(1)}%`),
                            ),
                          )),
                        ),
                      )
                    : null,
                  // #228：Key × 模型 交叉表 —— "哪个 Key 在打哪个模型"。
                  // 排查"某人的 Key 把贵的模型刷爆了"时的第一问，原来的两张表答不了。
                  Array.isArray(usage.cross) && usage.cross.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h('div', { className: cx('muted'), style: { marginBottom: '4px' } },
                          'Key × 模型（本月 · 合计 Top 40）'),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            h('th', null, 'Key 名称'),
                            h('th', null, '模型'),
                            h('th', null, '上游'),
                            h('th', null, '调用'),
                            h('th', null, '失败'),
                            h('th', null, '合计 (M)'),
                          )),
                          h('tbody', null, usage.cross
                            .filter((x) => showStale || x.deleted !== true)
                            .map((x) =>
                              h('tr', { key: `${x.keyId}\u0000${x.model}` },
                                h('td', { className: cx('mono') }, x.label ?? x.keyId),
                                h('td', { title: x.model }, x.model),
                                h('td', { className: cx('mono') }, x.provider),
                                h('td', { className: cx('mono') }, String(x.calls)),
                                h('td', { className: cx('mono') }, String(x.failed ?? 0)),
                                h('td', { className: cx('mono') }, fmtMTokens(x.total)),
                              ),
                            )),
                        ),
                      )
                    : null,
                  usage.kinds.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '按调用类型（' + (usageRange > 0 ? `最近 ${usageRange} 天` : '本月') + '）'),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            h('th', null, '类型'),
                            h('th', null, '调用'),
                            h('th', null, '合计 (M)'),
                          )),
                          h('tbody', null, usage.kinds.filter((k) => k.calls > 0).map((k) =>
                            h('tr', { key: k.id },
                              h('td', null, KIND_LABEL[k.id] ?? k.id),
                              h('td', { className: cx('mono') }, String(k.calls)),
                              h('td', { className: cx('mono') }, fmtMTokens(k.total)),
                            ),
                          )),
                        ),
                      )
                    : null,
                ),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '10px' } },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(
                    async () => {
                      const r = await rpc('usage/open', {})
                      setNotice({
                        tone: r.opened ? 'ok' : 'warn',
                        text: r.opened
                          ? `已在默认浏览器打开报告${r.reused ? '（复用一分钟内的同一份）' : ''}`
                          : `报告已生成（${r.path}），但自动打开失败：${r.openError ?? '未知原因'}`,
                        where: 'usage',
                      })
                      await loadUsage()
                    },
                    null,
                    'usage',
                  ),
              },
              '查看用量报告',
              h('span', { className: cx('ext') }, '↗'),
            ),
            h(
              'label',
              { className: cx('cap') },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: cfg.usage?.enabled !== false,
                disabled: busy,
                onChange: (e) =>
                  run(() => rpc('usage/setEnabled', { value: e.target.checked }), e.target.checked ? '已启用用量记账' : '已停止用量记账', 'usage'),
              }),
              '记录用量',
            ),
          ),
          h(Inline, { notice: noticeAt('usage') }),
        ),

        // 诊断
        h(
          'details',
          { key: 'diag', className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '健康与诊断'),
          h(
            'p',
            { className: cx('sectionHint') },
            '运行时健康一览：在飞请求与熔断、后端冷却状态、诊断导出。' +
              '熔断是"整体保护"（防止把上游打到限流），后端健康记忆是"逐档排序"（避开刚失败的那家）。',
          ),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                onClick: () =>
                  run(
                    async () => {
                      const r = await rpc('diagnostics/export', {})
                      setNotice({ tone: 'ok', text: `已导出脱敏诊断到：${r.path}`, where: 'diag' })
                    },
                    null,
                    'diag',
                  ),
              },
              '导出诊断信息',
            ),
            h('span', { className: cx('muted') }, '不含 key 明文、不含 prompt 正文'),
          ),

          // #238：数据目录 —— 用户必须能直接看到数据存在哪。
          // 之前因为"不知道数据位置"丢过全部 Key（那时数据在插件包内，
          // 一次重装被整体覆盖）。现在把路径与各文件状态摆在界面上。
          storage
            ? h(
                'div',
                { style: { marginTop: '10px' } },
                h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '数据目录'),
                h('div', { className: cx('cap') },
                  h('span', { style: { minWidth: '92px' } }, '位置'),
                  h('code', { className: cx('mono'), style: { userSelect: 'text' } }, storage.dir),
                  storage.legacy !== null
                    ? h(Pill, { tone: 'warn', title: '插件包内仍有旧版数据目录，已不再使用。确认新目录工作正常后可手动删除。' }, '旧目录残留')
                    : null,
                ),
                h('div', { className: cx('cap') },
                  h('span', { style: { minWidth: '92px' } }, '文件'),
                  ...['config', 'keys', 'usage', 'capabilities'].map((k) => {
                    const f = storage.files?.[k]
                    const label = { config: 'config', keys: 'keys', usage: '账本', capabilities: '能力' }[k]
                    return h('span', { key: k, className: cx('mono'), style: { marginRight: '10px' } },
                      `${label}:`,
                      f?.exists
                        ? h('span', { style: { color: '#2f9e44' } }, `${(f.bytes / 1024).toFixed(1)}K`)
                        : h('span', { style: { color: '#e03131' } }, '缺失'),
                    )
                  }),
                ),
                storage.legacy !== null
                  ? h('div', { className: cx('cap') },
                      h('span', { style: { minWidth: '92px' } }, '旧目录'),
                      h('code', { className: cx('mono'), style: { userSelect: 'text', opacity: 0.7 } }, storage.legacy.path),
                      h('span', { className: cx('capSrc') }, `· 内含 ${storage.legacy.files.length} 项（可删除）`),
                    )
                  : null,
                // #239：账本归档 —— 不会被自动删除，但必须让用户知道占了多少磁盘。
                // 没有归档时不占位（绝大多数用户看不到这行）。
                storage.archives !== undefined && storage.archives.count > 0
                  ? h('div', { className: cx('cap'), title: '账本超过大小上限时会滚动归档。归档是历史用量数据，不会被自动删除。\n需要腾空间时可在数据目录里手动删除较早的 usage-archive-*.jsonl。' },
                      h('span', { style: { minWidth: '92px' } }, '账本归档'),
                      h('span', { className: cx('mono') }, `${storage.archives.count} 个 · ${(storage.archives.bytes / 1024 / 1024).toFixed(2)} MB`),
                      h('span', { className: cx('capSrc') }, `· 最早 ${storage.archives.oldest ?? '—'}`),
                    )
                  : null,
                // 损坏隔离副本（正常为 0；反复损坏说明磁盘或写入有问题）
                storage.corruptions > 0
                  ? h('div', { className: cx('cap'), title: '文件损坏时会被改名留存为 .corrupt-<时间戳>，作为数据丢失事故的现场证据。\n自动保留最近 5 个，更早的会在启动时清理。' },
                      h('span', { style: { minWidth: '92px' } }, '损坏隔离'),
                      h('span', { className: cx('mono'), style: { color: '#e8590c' } }, `${storage.corruptions} 个`),
                      h('span', { className: cx('capSrc') }, '· 保留最近 5 个'),
                    )
                  : null,
                storage.needsKey === true
                  ? h(Notice, { tone: 'warn' },
                      '当前没有任何 API Key。如果是首次使用请在上方「API Key 管理」生成；' +
                        '如果是数据丢失（例如旧版本重装导致），需要重新生成并更新客户端配置。')
                  : null,
                // 迁移记录（如果有）
                Array.isArray(storage.migrated) && storage.migrated.length > 0
                  ? h('div', { className: cx('muted'), style: { marginTop: '4px' } },
                      `已从旧位置迁移 ${storage.migrated.length} 个文件：${storage.migrated.join(', ')}`)
                  : null,
              )
            : null,
          // 运行时摘要：一眼看清"网关当前是否健康"
          h(
            'div',
            { className: cx('caps'), style: { marginTop: '8px' } },
            h('div', { className: cx('cap') },
              h('span', { style: { minWidth: '92px' } }, '在飞请求'),
              h('span', { className: cx('mono') }, String(breaker?.concurrency?.inflight ?? status.inflight ?? 0)),
              breaker?.concurrency
                ? h('span', { className: cx('capSrc') },
                    `· LAN 上限 ${breaker.concurrency.lanMax}（本机保留 ${breaker.concurrency.reserved}）`)
                : null,
            ),
            h('div', { className: cx('cap') },
              h('span', { style: { minWidth: '92px' } }, '熔断'),
              breaker?.open
                ? h(Pill, { tone: 'warn' }, `已熔断 ${breaker.remainingSec}s`)
                : h(Pill, { tone: 'on' }, '正常'),
              h('span', { className: cx('capSrc') },
                breaker
                  ? `· 累计触发 ${breaker.stats?.opened ?? 0} 次 / 拒绝 ${breaker.stats?.rejected ?? 0} 次 / 命中限流 ${breaker.stats?.rateLimitHits ?? 0} 次`
                  : '· 状态读取中'),
            ),
          ),
          h('h4', { className: cx('subTitle') }, '后端健康记忆'),
          h(
            'p',
            { className: cx('sectionHint') },
            '故障转移链会记住刚失败过的后端：冷却期内把它们排到链尾，' +
              '这样后续请求不必为同一个已知故障再等满一次超时；' +
              '冷却到期自动回到你配置的位置。只改顺序，链上的后端一个都不会少。',
          ),
          backendHealth === undefined
            ? h('p', { className: cx('muted') }, '状态读取中…')
            : h(
                'div',
                { className: cx('caps') },
                h('div', { className: cx('cap') },
                  h('span', { style: { minWidth: '92px' } }, '冷却中'),
                  backendHealth.cooling > 0
                    ? h(Pill, { tone: 'warn' }, `${backendHealth.cooling} 档在链尾`)
                    : h(Pill, { tone: 'on' }, '全部健康'),
                  h('span', { className: cx('capSrc') },
                    `· 有记录 ${backendHealth.tracked} 档 / 已重排 ${backendHealth.reordered} 次`),
                ),
                (backendHealth.entries ?? []).length === 0
                  ? null
                  : h('div', { style: { marginTop: '6px' } },
                      h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '最近失败的后端'),
                      ...(backendHealth.entries ?? []).map((row) =>
                        h('div', { className: cx('cap'), key: row.key },
                          h('span', { style: { minWidth: '92px' } },
                            row.coolingSec > 0 ? h(Pill, { tone: 'warn' }, `冷却 ${row.coolingSec}s`) : h(Pill, { tone: 'on' }, '已恢复')),
                          h('span', { className: cx('mono') }, `${row.model}@${row.provider}`),
                          h('span', { className: cx('capSrc') },
                            `· 连败 ${row.streak} 次` +
                              (row.breakStreak > 0 ? ` / 断续 ${row.breakStreak} 次` : '') +
                              ` / 累计失败 ${row.fail} / 成功 ${row.ok}` +
                              (row.lastFailureCode === undefined ? '' : ` / 最近：${row.lastFailureCode}`)),
                        ),
                      )),
              ),
          h('div', { className: cx('row'), style: { marginTop: '6px' } },
            h('label', { className: cx('cap') },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: limits.backendHealth?.enabled !== false,
                disabled: busy,
                onChange: (e) => run(
                  () => rpc('config/set', { config: { limits: { backendHealth: { enabled: e.target.checked } } } }),
                  null,
                  'diag',
                ),
              }),
              '启用健康记忆（关掉就永远按配置顺序试）',
            ),
            h('label', { className: cx('field') },
              h('span', { className: cx('fieldLabel') }, '冷却秒数'),
              h('input', {
                className: cx('input'),
                type: 'number',
                min: 5,
                max: 3600,
                value: limits.backendHealth?.cooldownSec ?? 30,
                disabled: busy,
                onChange: (e) => run(() => rpc('config/set', { config: { limits: { backendHealth: { cooldownSec: Number(e.target.value) } } } }), null, 'diag'),
              }),
            ),
            h('label', { className: cx('field') },
              h('span', { className: cx('fieldLabel') }, '冷却上限秒数'),
              h('input', {
                className: cx('input'),
                type: 'number',
                min: 5,
                max: 3600,
                value: limits.backendHealth?.maxCooldownSec ?? 300,
                disabled: busy,
                onChange: (e) => run(() => rpc('config/set', { config: { limits: { backendHealth: { maxCooldownSec: Number(e.target.value) } } } }), null, 'diag'),
              }),
            ),
            h('button', {
              className: cx('btn'),
              disabled: busy,
              title: '清空健康记忆：所有后端立即恢复配置顺序（它们确实还坏着的话会很快重新进入冷却）',
              onClick: () => void run(async () => {
                const r = await rpc('backendHealth/reset', {})
                setBackendHealth(r.after)
              }, '已清空后端健康记忆', 'diag'),
            }, '清空记忆'),
          ),
          h(Inline, { notice: noticeAt('diag') }),
        ),

        // 危险操作（P16）：集中放置、二次确认，与普通设置分开
        h(
          'details',
          { key: 'danger', className: cx('section', 'collapsible'), style: { borderColor: '#ffa39e' } },
          h('summary', { className: cx('sectionTitle') }, '⚠ 危险操作'),
          h(
            'p',
            { className: cx('sectionHint') },
            '这些操作会立即影响局域网服务或丢弃运行状态，均需二次确认。',
          ),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                onClick: () => {
                  if (!window.confirm('解除熔断？若上游仍在限流，很快会再次触发。')) return
                  void run(async () => {
                    const r = await rpc('breaker/reset', {})
                    setBreaker(r.after)
                  }, '已解除熔断', 'danger')
                },
              },
              '解除熔断',
            ),
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                title: '把所有配置恢复为出厂默认（不影响已生成的 API Key 与用量账本）',
                onClick: () => {
                  if (!window.confirm('把所有设置恢复为出厂默认？\n\n不会删除 API Key 与用量账本。')) return
                  void run(async () => {
                    await rpc('config/reset', { keepKeys: true })
                    await refresh()
                    await loadFilters()
                    await loadBreaker()
                  }, '已恢复出厂默认设置', 'danger')
                },
              },
              '恢复出厂默认设置',
            ),
            h(
              'button',
              {
                className: cx('btn', 'btnDanger'),
                disabled: busy || listens.length > 0 === false,
                title: '停止全部监听并关闭服务（不会卸载插件）',
                onClick: () => {
                  if (!window.confirm('停止全部监听并关闭服务？\n\n局域网将立刻无法访问，可随时重新启用。')) return
                  void run(async () => {
                    await rpc('config/set', { config: { enabled: false } })
                    await refresh()
                  }, '已停止服务并关闭全部监听', 'danger')
                },
              },
              '立即停止服务',
            ),
          ),
          h(Inline, { notice: noticeAt('danger') }),
        ),
      ])
    }

    // ────────────────────────────── provider 页 ──────────────────────────────

    function ProviderPage(props) {
      const { rpc, provider } = props
      const [models, setModels] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [perf, setPerf] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      // ⚠ `rpc` 每次渲染都是新函数引用；若把它放进依赖数组，
      //    effect 会无限重跑并把 openId 重置为 null，表现为"模型点不开"（本机实测）。
      //    因此用 ref 持有最新 rpc，依赖只留 provider.id。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      React.useEffect(() => {
        let cancelled = false
        setModels(null)
        setOpenId(null)
        setPerf(null)
        setNotice(null)
        void (async () => {
          try {
            const r = await rpcRef.current('models/list', { provider: provider.id })
            if (!cancelled) setModels(r.models ?? [])
          } catch (error) {
            if (!cancelled) setNotice({ tone: 'error', text: error.message })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [provider.id])

      if (notice && models === null) return h(Notice, { tone: notice.tone }, notice.text)
      if (models === null) return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取模型中…')
      if (models.length === 0) return h('div', { className: cx('empty') }, '该 provider 当前没有公开模型')

      return h(
        'div',
        null,
        h(Notice, { tone: 'info' }, `provider「${provider.name}」共 ${models.length} 个模型。模型公开名为 <模型>@${provider.slug}。`),
        notice ? h(Notice, { tone: notice.tone }, notice.text) : null,
        models.map((m) =>
          h(
            'div',
            { key: m.publicName, className: cx('model') },
            h(
              'button',
              { className: cx('modelHead'), onClick: () => setOpenId(openId === m.publicName ? null : m.publicName) },
              h(
                'span',
                { className: cx('modelTitle') },
                h('span', { className: cx('mono') }, m.publicName),
                m.description ? h('div', { className: cx('muted') }, m.description) : null,
              ),
              h('span', { className: cx('muted', 'nowrap') }, openId === m.publicName ? '▴ 收起' : '▾ 展开'),
            ),
            openId === m.publicName
              ? h(
                  'div',
                  { className: cx('modelBody') },
                  h(CapabilityPanel, { rpc, provider: provider.id, model: m.model, onNotice: setNotice, onBusy: setBusy }),
                  h(
                    'div',
                    { className: cx('row'), style: { marginTop: '10px' } },
                    h(
                      'button',
                      {
                        className: cx('btn', 'btnPrimary'),
                        disabled: busy,
                        onClick: async () => {
                          setBusy(true)
                          setPerf(null)
                          setNotice(null)
                          try {
                            const r = await rpc('model/perf', { provider: provider.id, model: m.model })
                            setPerf(r)
                          } catch (error) {
                            setNotice({ tone: 'error', text: error.message })
                          } finally {
                            setBusy(false)
                          }
                        },
                      },
                      '性能测试',
                    ),
                    h('span', { className: cx('muted') }, '一次最短调用，测延迟 / 首字 / 速度'),
                  ),
                  perf
                    ? perf.ok
                      ? h('div', { className: cx('green'), style: { marginTop: '8px' } },
                          `✅ 延迟 ${perf.latencyMs} ms · 首字 ${perf.ttftMs ?? '—'} ms · ${perf.tokPerSec ?? '—'} tok/s`)
                      : perf.kind === 'timeout'
                        ? h('div', { className: cx('red'), style: { marginTop: '8px' } }, `time out（${perf.timeoutMs}ms）`)
                        : h('div', { className: cx('red'), style: { marginTop: '8px' } }, `上游错误：${perf.raw ?? perf.message}`)
                    : null,
                )
              : null,
          ),
        ),
      )
    }

    // ────────────────────────────── 能力面板（P4） ──────────────────────────────

    /** 三态 → 复选框视觉与文案。 */
    const VALUE_META = {
      supported: { tone: 'on', text: '支持' },
      unsupported: { tone: 'off', text: '不支持' },
      unknown: { tone: 'warn', text: '未知' },
    }

    const SOURCE_LABEL = {
      dsh: '来自 DSH',
      declared: '已手动修改',
      profile: '推测',
      learned: '上游报错学习',
      probe: '已测试',
    }

    /** 功能测试项的中文名（结果列表用）。 */
    const CAP_ITEM_LABEL = {
      authoritative: '权威值刷新',
      connectivity: '基础连通',
      tools: '工具调用',
      temperature: '温度参数',
      jsonMode: 'JSON 模式',
      stop: '停止序列',
      image: '图片输入',
      parallelTools: '并行工具调用',
    }

    /** 一行能力：三态复选框 + 来源标注 + 可选"恢复权威值"。 */
    function CapRow(props) {
      const { label, field, cap, authoritative, busy, onChange, onReset } = props
      const value = cap?.value ?? 'unknown'
      const src = cap?.source ?? null
      const meta = VALUE_META[value] ?? VALUE_META.unknown
      const overridden = src === 'declared'
      // `conflict`（与权威值不一致）**不再用于渲染**：见下方说明 —— 由「恢复默认」按钮表达。
      // 保留计算仅用于注释说明；若将来需要在别处提示冲突可复用。

      // 用 indeterminate 表达"未知"（原生属性，无需自造视觉）
      const boxRef = React.useRef(null)
      React.useEffect(() => {
        if (boxRef.current !== null) boxRef.current.indeterminate = value === 'unknown'
      }, [value])

      return h(
        'div',
        { className: cx('cap') },
        h('input', {
          ref: boxRef,
          className: cx('checkbox'),
          type: 'checkbox',
          checked: value === 'supported',
          disabled: busy,
          onChange: (e) => onChange(field, e.target.checked ? 'supported' : 'unsupported'),
        }),
        h('span', { style: { minWidth: '92px' } }, label),
        h(Pill, { tone: meta.tone }, meta.text),
        src ? h('span', { className: cx('capSrc') }, `· ${SOURCE_LABEL[src] ?? src}`) : h('span', { className: cx('capSrc') }, '· 无依据'),
        // ⚠ 这里**刻意不再显示**"（DSH 记录的原值：X）"与"⚠ 与 DSH 记录不一致"。
        //
        // 用户指出：**「恢复默认」按钮的存在本身**已经表达了"当前值是你改过的、
        // 与默认（权威）值不同"这层含义，再在两侧各挂一长串注释是冗余的，
        // 而且会让**有权威值的项（图片/推理）比其它项多一段文字**，
        // 视觉上参差不齐（各项声明行应当外观一致）。
        // 需要看原值时，悬停「恢复默认」即可（title 里有）。
        overridden
          ? h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                title:
                  authoritative != null
                    ? `按 DSH 记录的权威值重置（当前值由你手动声明；权威值：${VALUE_META[authoritative]?.text ?? authoritative}）`
                    : '按 DSH 记录的权威值重置（当前值由你手动声明）',
                onClick: () => onReset(field),
              },
              '恢复默认',
            )
          : null,
        cap?.note ? h('span', { className: cx('capSrc'), title: cap.note }, 'ⓘ') : null,
      )
    }

    /** 能力面板：权威项 + 档 B 项 + 测试按钮。 */
    function CapabilityPanel(props) {
      const { rpc, provider, model, onNotice, onBusy } = props
      const [caps, setCaps] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      /** 测试进度：`{elapsed, expect, done, current}` 或 null。 */
      const [progress, setProgress] = React.useState(null)
      /**
       * 当前测试轮次号。用于**作废在途的轮询回调**：
       * `clearInterval` 拦不住"已发出、尚未返回"的那次请求，它落地后会
       * 把已清空的进度又写回来（实测导致进度行永久残留）。
       * 每次测试递增；回调落地时若发现轮次已变，直接丢弃。
       */
      const myRunId = React.useRef(0)

      /**
       * 当前测试轮询的 interval 句柄。
       *
       * 只有局部 `const tick` + finally 里的 clearInterval 不够：组件在测试进行中
       * 被卸载（切模型 / 关面板）时 finally 永远不执行，那个 interval 会以 300ms
       * 一直打 model/testProgress，直到页面刷新才停。
       */
      const tickRef = React.useRef(null)

      React.useEffect(() => () => {
        // 卸载时：停掉轮询 + 作废在途回调
        if (tickRef.current !== null) { clearInterval(tickRef.current); tickRef.current = null }
        myRunId.current += 1
      }, [])
      /** 本次将测试的项（用于显示总项数）。 */
      const testItems = ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image']

      // 同上：`rpc`/`onNotice` 每次渲染都是新引用，用 ref 持有，依赖只留模型标识。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc
      const noticeRef = React.useRef(onNotice)
      noticeRef.current = onNotice

      /**
       * 读取失败时的态。
       *
       * 必须是 null 而不是 undefined：下面渲染只有两条分支——null 走「读取中」，
       * 其余一律当成"有数据"去读 caps.authoritativeRaw。写 undefined 会直接
       * 在渲染里抛 TypeError，而 client.js 没有 ErrorBoundary，整块面板白屏。
       */
      const [loadError, setLoadError] = React.useState(null)
      const load = React.useCallback(async () => {
        setLoadError(null)
        try {
          const r = await rpcRef.current('model/capabilities', { provider, model })
          setCaps(r.capabilities ?? null)
        } catch (error) {
          setCaps(null)
          setLoadError(error?.message ?? String(error))
          noticeRef.current?.({ tone: 'error', text: `读取能力失败：${error.message}` })
        }
      }, [provider, model])

      React.useEffect(() => {
        void load()
      }, [load])

      const setField = async (field, value) => {
        setBusy(true)
        onBusy?.(true)
        try {
          const r = await rpc('model/capability/set', { provider, model, field, value })
          setCaps(r.capabilities)
          onNotice?.({ tone: 'ok', text: `已把「${field}」声明为 ${VALUE_META[value]?.text ?? value}（以你的判断为准）` })
        } catch (error) {
          onNotice?.({ tone: 'error', text: error.message })
        } finally {
          setBusy(false)
          onBusy?.(false)
        }
      }

      const runTest = async () => {
        setBusy(true)
        onBusy?.(true)
        setTestResult(null)
        // 逐项进度。设计要点（两次实测踩坑后定型）：
        //
        // ① **本地计时优先，绝不依赖轮询才开始显示**。
        //    原先只在轮询成功时才 setProgress，一旦轮询拿不到数据（超时/被丢弃），
        //    用户在整个测试过程中**看不到任何反馈**，结束后才突然出现一行
        //    （实测：11 秒的测试全程无进度）。
        //    现在：进入测试立刻显示进度行，本地计时每秒自走；
        //    服务端数据到了只作**补充**（更精确的项数/当前项）。
        //
        // ② **用 runId 作废在途轮询**。
        //    `clearInterval` 只阻止"未来"的轮询，挡不住"已在飞行中"的那一次；
        //    它返回后仍会 setProgress，把 finally 里清掉的行**又写回来** →
        //    进度行永久残留（实测：测试完成后一直显示"已测 6/6 项 · 已用 11 秒"）。
        //    每次测试分配唯一 runId，回调落地时先校验，不是当前轮次就直接丢弃。
        const POLL_MS = 300
        const expectCount = testItems?.length ?? 7
        const startedAt = Date.now()
        myRunId.current += 1
        const runId = myRunId.current
        // 立即显示（visible 恒为 true，不再有"要不要显示"的启发式）
        setProgress({ elapsed: 0, expect: expectCount, done: 0, current: null })
        const tick = setInterval(() => {
          // ① 先本地推进计时（不依赖任何 IO）
          if (myRunId.current !== runId) return
          setProgress((prev) => (prev === null ? null : { ...prev, elapsed: Math.round((Date.now() - startedAt) / 1000) }))
          // ② 再尝试取服务端的精确进度（拿不到也不影响上面的计时）
          void (async () => {
            try {
              const p = await rpc('model/testProgress', {})
              // ★ 关键：本次测试已结束（或被新测试取代）→ 丢弃这个在途结果
              if (myRunId.current !== runId) return
              const total = p?.total > 0 ? p.total : expectCount
              setProgress((prev) => (prev === null ? null : {
                ...prev,
                elapsed: Math.round((Date.now() - startedAt) / 1000),
                expect: total,
                // 服务端的 done 已排除 authoritative；此处再钳一次作防御
                done: Math.min(p?.doneCount ?? 0, total),
                current: CAP_ITEM_LABEL[p?.current] ?? p?.current ?? null,
              }))
            } catch {
              /* 轮询失败无所谓：本地计时已在走 */
            }
          })()
        }, POLL_MS)
        tickRef.current = tick
        onNotice?.({ tone: 'info', text: `正在逐项测试（共 ${expectCount} 项，每项一次真实模型调用）…` })
        try {
          const r = await rpc('model/test', { provider, model })
          setTestResult(r.results)
          setCaps(r.capabilities)
          // 项数按**正式测试项**计（排除 `authoritative`：它只是前置的权威值刷新，
          // 不是被测能力）。否则会出现"测试完成：7 项"与"已测 6/6"自相矛盾。
          const realCount = r.results.filter((x) => x.item !== 'authoritative').length
          // 提示语必须**如实说明结果去了哪里**：测试现在会把可写项的结论
          // 直接写进能力覆盖（这是用户明确要求的行为），所以再说"不会自动改写"
          // 就是错的，会让人以为还得手动点一遍。
          const appliedCount = r.results.filter((x) => x.applied === true).length
          onNotice?.({
            tone: 'ok',
            text:
              `测试完成：${realCount} 项` +
              (appliedCount > 0
                ? `，其中 ${appliedCount} 项已写回能力（下方绿色来源即为实测结论）`
                : '，本次没有可写回的结论（未知项不覆盖已有结论）'),
          })
        } catch (error) {
          onNotice?.({ tone: 'error', text: `测试失败：${error.message}` })
        } finally {
          // 先作废本轮（让在途轮询回调丢弃结果），再清理
          myRunId.current += 1
          clearInterval(tick)
          tickRef.current = null
          setProgress(null)
          setBusy(false)
          onBusy?.(false)
        }
      }

      if (caps === null || caps === undefined) {
        return h(
          'div',
          { className: cx('caps') },
          loadError === null
            ? h('span', { className: cx('spin') }, '读取能力中…')
            : h(
                'span',
                null,
                '读取能力失败：' + loadError,
                h('button', { className: cx('btn'), style: { marginLeft: '8px' }, onClick: () => void load() }, '重试'),
              ),
        )
      }

      const raw = caps.authoritativeRaw ?? {}
      const rows = [
        ['text', '文本输入', undefined],
        ['image', '图片输入', raw.image],
        ['reasoning', '推理能力', raw.reasoning],
        ['tools', '工具调用', undefined],
        ['parallelTools', '并行工具调用', undefined],
        ['jsonMode', 'JSON 模式', undefined],
        ['temperature', '温度参数', undefined],
        ['stop', '停止序列', undefined],
      ]

      return h(
        'div',
        null,
        h(
          'div',
          { className: cx('caps') },
          rows.map(([field, label, authoritative]) =>
            h(CapRow, {
              key: field,
              label,
              field,
              cap: caps[field],
              authoritative,
              busy,
              onChange: setField,
              onReset: (f) => setField(f, null),
            }),
          ),
          // 数值型能力（非复选框）
          h('div', { className: cx('cap') },
            h('span', { style: { minWidth: '92px' } }, '上下文窗口'),
            h('span', { className: cx('mono') },
              caps.contextWindow?.value !== undefined && typeof caps.contextWindow.value === 'number'
                ? String(caps.contextWindow.value)
                : '未知'),
            h('span', { className: cx('capSrc') }, '· 来自 DSH'),
          ),
          h('div', { className: cx('cap') },
            h('span', { style: { minWidth: '92px' } }, '最大输出'),
            h('span', { className: cx('mono') },
              caps.maxOutputTokens?.value !== undefined && typeof caps.maxOutputTokens.value === 'number'
                ? String(caps.maxOutputTokens.value)
                : '未知'),
            h('span', { className: cx('capSrc') }, '· 来自 DSH'),
          ),
          caps.reasoning?.efforts?.length
            ? h('div', { className: cx('cap') },
                h('span', { style: { minWidth: '92px' } }, '可选推理档位'),
                h('span', { className: cx('mono') }, caps.reasoning.efforts.join(' / ')),
                caps.reasoning.defaultEffort ? h('span', { className: cx('capSrc') }, `· 默认 ${caps.reasoning.defaultEffort}`) : null,
              )
            : null,
          // 第十轮：四档契约。面板必须把“对外只公开四档”与“每档落到哪个真实词”
          // 同时展示 —— 只说四档，用户不知道背后差几档；只列真实词，他又不知道该怎么写。
          caps.contractLevels?.length
            ? h('div', { className: cx('cap') },
                h('span', { style: { minWidth: '92px' } }, '对外四档'),
                h('span', { className: cx('mono') },
                  caps.contractLevels.map((c) => `${c.level}${typeof c.word === 'string' ? '→' + c.word : ''}`).join(' / ')),
                h('span', { className: cx('capSrc') }, '· 客户只说 minimal/low/medium/high，网关自动对到各家真实词'),
              )
            : null,
        ),
        h(
          'div',
          { className: cx('row'), style: { marginTop: '8px' } },
          h('button', { className: cx('btn', 'btnPrimary'), disabled: busy, onClick: runTest },
            busy ? h('span', null, h('span', { className: cx('spin') }), '功能测试中…') : '功能测试'),
          // 说明放按钮**右侧**（与"性能测试"一行一致，用户要求统一）。
          // ⚠ 必须**短**：`.dim-lt-row` 是 flex-wrap，文案一长就换行到下一排，
          // 视觉上又变成"在按钮下方"（用户实测反馈）。
          // 因此行内只写"这是什么"，"结果不会自动回填"这条要点放到结果区的提示里。
          h('span', { className: cx('muted') }, '逐项真实调用，发现隐藏能力'),
        ),
        // 测试进度：显示"已测 N / 共 M · 正在测 XXX · 已用 Xs"
        // 进入测试后**立即显示**，本地计时自走；服务端数据到达后补充精确项数。
        // （不再有 visible 门槛 —— 那会让轮询失败时全程无反馈。）
        progress !== null
          ? h('div', { className: cx('inline', 'inlineOk'), style: { marginTop: '6px' } },
              h('span', { className: cx('spin') }),
              ` 已测 ${Math.min(progress.done, progress.expect)}/${progress.expect} 项` +
                (progress.current !== null && progress.current !== undefined ? ` · 正在测「${progress.current}」` : '') +
                ` · 已用 ${progress.elapsed} 秒` +
                (progress.elapsed >= 25 ? '（图片项最长等 30 秒）' : ''),
            )
          : null,
        testResult
          ? h('div', { className: cx('caps'), style: { marginTop: '8px' } },
              // 结果区顶部固定提示（3b 要点）：把"不会自动回填"讲清楚。
              // 放在这里而不是按钮旁，是因为按钮那行空间有限（文案一长就换行）。
              h(
                Notice,
                { tone: 'info' },
                '下面是实测结果，仅供你参考 —— 不会自动改写上面的能力声明。要改声明，请直接点左侧复选框。',
              ),
              // 汇总提示（P16 改进）：同一原因（如"未配置凭据"）会在多行重复出现，
              // 逐行显示既啰嗦又把药丸挤扁。这里**合并成一条**置顶，行内只留状态。
              //
              // ⚠ 措辞（方案 1）：原先写作「（N 项一致）」，但"N 项"对用户没有意义
              //（他不知道为什么会有"项"这个概念）。改为**点名具体是哪些项**，
              // 并说明这些项是同一个原因导致的。
              (() => {
                const notes = testResult.map((r) => r.note).filter((n) => typeof n === 'string' && n.length > 0)
                const counted = new Map()
                for (const n of notes) counted.set(n, (counted.get(n) ?? 0) + 1)
                const repeated = [...counted.entries()].filter(([, c]) => c > 1)
                if (repeated.length === 0) return null
                return h(
                  Notice,
                  { tone: 'warn' },
                  repeated
                    .map(([n, c]) => {
                      const names = testResult
                        .filter((r) => r.note === n)
                        .map((r) => CAP_ITEM_LABEL[r.item] ?? r.item)
                      return `${names.join('、')}：${n}` + (c > names.length ? `（${c} 项）` : '')
                    })
                    .join('；'),
                )
              })(),
              testResult.map((r) => {
                // 「权威值刷新」不是单项三态，而是**一组权威值快照**
                //（`{image, reasoning, contextWindow, maxOutputTokens…}`，没有 `value` 字段）。
                // 用三态药丸渲染会取到 undefined → 显示成孤零零的 `?`（用户实测发现）。
                // 这里给它单独的渲染分支：直接列出刷新到的权威值。
                if (r.item === 'authoritative') {
                  const bits = []
                  if (r.image !== undefined) bits.push(`图片=${VALUE_META[r.image]?.text ?? r.image}`)
                  if (r.reasoning !== undefined) bits.push(`推理=${VALUE_META[r.reasoning]?.text ?? r.reasoning}`)
                  if (typeof r.contextWindow === 'number') bits.push(`上下文=${r.contextWindow.toLocaleString()}`)
                  if (typeof r.maxOutputTokens === 'number') bits.push(`最大输出=${r.maxOutputTokens.toLocaleString()}`)
                  else if (r.maxOutputTokens !== undefined) bits.push(`最大输出=${VALUE_META[r.maxOutputTokens]?.text ?? r.maxOutputTokens}`)
                  return h('div', { key: r.item, className: cx('cap') },
                    h('span', { style: { minWidth: '92px' } }, '权威值刷新'),
                    h(Pill, { tone: 'on' }, '已刷新'),
                    h('span', { className: cx('capSrc') }, bits.length > 0 ? bits.join(' · ') : '无可用权威值'),
                  )
                }
                // 已在汇总里说过的重复原因，行内不再重复显示
                const noteRepeated =
                  typeof r.note === 'string' &&
                  r.note.length > 0 &&
                  testResult.filter((x) => x.note === r.note).length > 1
                // 测试结果的药丸文案（方案 1+2，用户要求）：
                // `supported` 在这条链路上其实只代表"**实测请求没报错**"，
                // 用能力矩阵里的"支持"会让人以为"参数确实生效了"——不准确。
                // 因此测试结果区改用「已通过 / 未通过 / 待定」，更贴合它的真实含义。
                const TEST_META = {
                  supported: { tone: 'on', text: '已通过' },
                  unsupported: { tone: 'off', text: '未通过' },
                  unknown: { tone: 'warn', text: '待定' },
                }
                const meta = TEST_META[r.value] ?? VALUE_META[r.value] ?? { tone: 'warn', text: String(r.value ?? '?') }
                return h('div', { key: r.item, className: cx('cap') },
                  h('span', { style: { minWidth: '92px' } }, CAP_ITEM_LABEL[r.item] ?? r.item),
                  h(Pill, { tone: meta.tone }, meta.text),
                  r.ms !== undefined ? h('span', { className: cx('capSrc') }, `${r.ms} ms`) : null,
                  r.verified === true ? h('span', { className: cx('green') }, '内容已读出') : null,
                  r.verified === false && r.answers ? h('span', { className: cx('inlineErr') }, `模型读出的内容不符（它说："${String(r.answers).slice(0, 40)}"）`) : null,
                  // 方法/依据说明一律收进 ⓘ 悬停（方案 1）：行内只留结论，避免长句挤爆版面。
                  r.note && !noteRepeated
                    ? h('span', { className: cx('infoIcon'), title: r.note, 'aria-label': r.note }, 'ⓘ')
                    : null,
                  // 回写标记：让"这次测试改变了什么"在行内直接可见。
                  // 没有它的话，用户点完测试只看到药丸变色，不知道是不是自己
                  // 手动点的、还是系统真写进去了（实测要求：写回必须可追溯）。
                  r.applied === true
                    ? h('span', { className: cx('green'), title: '该项结论已写入能力覆盖（下次请求即按此判定）' }, '已写回')
                    : null,
                  r.evidence ? h('span', { className: cx('capSrc'), title: r.evidence }, '（有依据）') : null,
                  r.error ? h('span', { className: cx('red') }, r.error) : null,
                )
              }),
            )
          : null,
      )
    }

    // ────────────────────────────── 主页面 ──────────────────────────────

    function LanternPage(props) {
      // 只用 `rpc`：`close` 曾用于渲染一个与设置弹窗 × 重复的「关闭」按钮，已移除。
      const { rpc } = props
      const [status, setStatus] = React.useState(null)
      const [selected, setSelected] = React.useState(null)

      // ⚠ 关键：`rpc` 每次渲染都是新引用。
      // 若把它放进依赖数组，定时器会反复重建；更不能把"轮询计数"用作子组件 key——
      // 那会让 ProviderPage 每 5 秒被强制重挂载，表现为**模型永远点不开**
      // （openId 被重置）。本机实测踩过，故用 ref 稳定引用、key 只随选择变化。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          try {
            const s = await rpcRef.current('status', {})
            if (!cancelled) setStatus(s)
          } catch {
            /* 面板仍可用（显示空状态） */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      const providers = status?.directory?.providers ?? []
      const allProviders = status?.directory?.allProviders ?? providers
      const current = selected === null ? 'status' : selected
      const activeProvider = providers.find((p) => p.id === current) ?? allProviders.find((p) => p.id === current)

      return h(
        'section',
        { className: cx('page'), 'aria-label': 'LANtern 设置' },
        h(
          'header',
          { className: cx('header') },
          h(
            'div',
            { className: cx('brand') },
            h('strong', { className: cx('brandName') }, 'LANtern · 局域网模型灯塔'),
            h('p', { className: cx('brandDesc') }, '把本机 DSH 的全部模型公开给局域网'),
          ),
          h(
            'div',
            { className: cx('headerActions') },
            status ? h(Pill, { tone: status.enabled ? 'on' : 'off' }, status.enabled ? '运行中' : '已停止') : null,
            // 局域网可达性：用**短标记 + 悬停提示**，避免长文案把 header 挤变形
            //（header 会随面板宽度换行；面板仅 ~340px，长句会占掉好几行）。
            (() => {
              if (!status?.enabled) return null
              const activeListen = (status.listen ?? []).filter((x) => x.listening !== false)
              if (activeListen.length === 0) return null
              const lanReachable = activeListen.some((x) => x.bind === '0.0.0.0' || x.bind === '::')
              return h(
                'span',
                {
                  className: cx('capSrc'),
                  title: lanReachable
                    ? '监听地址为 0.0.0.0，局域网内其他设备可直接访问。'
                    : '当前只绑本机回环（127.0.0.1），局域网访问不到。\n' +
                      '要暴露到局域网：改用 standalone 模式，或让 DSH 以 --host 0.0.0.0 启动。',
                },
                lanReachable ? '· 局域网可访问' : '· 仅本机',
              )
            })(),
            status ? h('span', { className: cx('muted') }, `${status.directory?.publicCount ?? 0} 个模型`) : null,
            // 不再渲染「关闭」按钮（用户指出）：DSH 设置弹窗**右上角本来就有 ×**，
            // 这个按钮是从 Jet Hub 原样复制来的，功能与 × 完全重复，属冗余入口。
          ),
        ),
        h(
          'div',
          { className: cx('layout') },
          h(
            'nav',
            { className: cx('rail'), role: 'tablist', 'aria-label': 'LANtern 导航' },
            // ① 状态与安全：固定在最上方（用户要求：位于各 provider 之上）
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: cx('nav'),
                'aria-selected': current === 'status',
                onClick: () => setSelected('status'),
              },
              h('span', { className: cx('navIcon') }, '⚙'),
              h(
                'span',
                { className: cx('navLabel') },
                h('strong', null, '状态与安全'),
                h('span', null, '开关 · 端口 · Key'),
              ),
              null,
            ),
            h('div', { className: cx('railDivider') }),
            // 自定义模型：功能入口，排在所有 provider 之前（它跨 provider 绑定多个模型）
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: cx('nav', 'navAccent'),
                'aria-selected': current === 'custom',
                onClick: () => setSelected('custom'),
              },
              h('span', { className: cx('navIcon') }, '⇄'),
              h(
                'span',
                { className: cx('navLabel') },
                h('strong', null, '自定义模型'),
                h('span', null, '多后端故障转移'),
              ),
              h('span', { className: cx('navCount') }, String((status?.config?.customModels ?? []).length)),
            ),
            // #194：自定义工具入口已移除（生图/生视频一并下线）。
            h('div', { className: cx('railDivider') }),
            providers.map((p) =>
              h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  role: 'tab',
                  className: cx('nav'),
                  'aria-selected': current === p.id,
                  onClick: () => setSelected(p.id),
                },
                h('span', { className: cx('navIcon') }, p.visible ? '▸' : '·'),
                h(
                  'span',
                  { className: cx('navLabel') },
                  // 悬停提示**统一格式**：两行各自一个 title 会导致"有时看到大字、
                  // 有时看到小字"的不一致体验（用户实测发现）。
                  // 这里两行共用同一个 `名称(@slug)`，与模型公开名 `<model>@<slug>` 同构。
                  (() => {
                    const nameTip = p.visible
                      ? `${p.name}(@${p.slug})`
                      : `${p.name}（隐藏：${p.hiddenReason ?? '不可用'}）`
                    return [
                      h('strong', { key: 'n', title: nameTip }, p.name),
                      h('span', { key: 's', title: nameTip }, p.visible ? p.slug : `隐藏（${p.hiddenReason ?? '不可用'}）`),
                    ]
                  })(),
                ),
                h('span', { className: cx('navCount') }, p.visible ? String(p.modelCount) : '—'),
              ),
            ),
            providers.length === 0
              ? h('div', { className: cx('railFoot') }, '当前没有可显示的 provider')
              : null,
          ),
          h(
            'main',
            { className: cx('panel'), role: 'tabpanel' },
            // key 只随"当前选择"变化，**不随轮询变化**（否则每次轮询都会重挂载子页，
            // 展开状态与输入都会被清空）。
            // #194：'tools' 页已下线，旧状态回退到 status，避免白屏。
            (current === 'tools' || current === undefined ? 'status' : current) === 'status'
              ? h(StatusPage, { key: 'status', rpc })
              : current === 'custom'
                ? h(CustomModelsPage, { key: 'custom', rpc })
                  : activeProvider
                  ? h(ProviderPage, { key: current, rpc, provider: activeProvider })
                  : h('div', { className: cx('empty') }, '该 provider 已不可用'),
          ),
        ),
      )
    }

    // ────────────────────────────── 自定义模型（虚拟名 + 故障转移） ──────────────────────────────

    /**
     * 绑定行：序号 + 公开名 + 上移/下移/删除。
     *
     * 顺序即故障转移优先级，所以"上移/下移"不是装饰——它就是功能本体。
     * 不做拖拽：设置窗口只有 ~340px 宽，拖拽在窄栏里极易误触。
     */
    function BindingRow(props) {
      const { binding, index, total, status, onMove, onRemove } = props
      const ok = status === undefined ? null : status.available
      return h(
        'div',
        { className: cx('bindRow') },
        h('span', { className: cx('bindOrder') }, String(index + 1)),
        h(
          'span',
          { className: cx('bindName'), title: binding },
          h('code', { className: cx('mono') }, binding),
          ok === null
            ? null
            : h(Pill, { tone: ok ? 'on' : 'warn' }, ok ? '可用' : status?.reason ? '失效' : '未知'),
        ),
        h(
          'span',
          { className: cx('bindOps') },
          h('button', {
            className: cx('iconBtn'),
            type: 'button',
            title: '上移（提高优先级）',
            disabled: index === 0,
            onClick: () => onMove(index, -1),
          }, '↑'),
          h('button', {
            className: cx('iconBtn'),
            type: 'button',
            title: '下移（降低优先级）',
            disabled: index === total - 1,
            onClick: () => onMove(index, 1),
          }, '↓'),
          h('button', {
            className: cx('iconBtn', 'iconBtnDanger'),
            type: 'button',
            title: '移除该绑定',
            onClick: () => onRemove(index),
          }, '✕'),
        ),
      )
    }

    /**
     * 自定义模型页。
     *
     * 核心心智模型：**一个虚拟名 → 一串有序真实模型**。
     * 请求打到虚拟名时按顺序逐个尝试，第一个成功就返回；
     * 顺序即优先级，所以绑定列表必须能被上下移动。
     */
    function CustomModelsPage(props) {
      const { rpc } = props
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      const [models, setModels] = React.useState(null)
      const [candidates, setCandidates] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tested, setTested] = React.useState(null)
      // 新建草稿
      const [draftName, setDraftName] = React.useState('')
      const [draftDisplay, setDraftDisplay] = React.useState('')
      // 编辑中的绑定（按 id 存，切换展开时丢弃未保存改动）
      const [editBindings, setEditBindings] = React.useState([])
      const [pick, setPick] = React.useState('')
      // 编辑中的调优参数（后端首包超时 / 整个请求的重试预算）。
      // 用字符串存：输入过程中会出现 "" 这类中间态，立刻 Number() 会把光标吃掉，
      // 保存时才收敛成数字（服务端还有一层 normalize 兜底）。
      const [editTimeoutMs, setEditTimeoutMs] = React.useState('')
      const [editRetries, setEditRetries] = React.useState('')
      // 编辑中的模型名与显示名。
      //
      // 以前这里**没有**这两个 state：编辑区只能改绑定链与调优参数，模型名与
      // 显示名创建后就是死的。用户想改个名字只能删了重建——而删掉会把这条链
      // 上所有绑定、以及已经发给客户端的那个名字一起作废。
      //
      // 服务端 `customModels/update` 一直支持改 name/display（校验齐全：
      // 字符集、长度、重名检查），只是前端从没把这两个字段发出去。
      const [editName, setEditName] = React.useState('')
      const [editDisplay, setEditDisplay] = React.useState('')
      // 编辑中的「推理档位白名单」与「默认档」（第十轮 #118）。
      //
      // 这两项是用户反馈"推理等级不能设置、不能自定义"的直接修复：
      // 之前面板上**一个相关控件都没有**，服务端也没有对应字段，
      // 管理员只能改 provider 级的"支不支持推理"，改不了"开放哪几档"。
      //
      // 用字符串 state 而不是数组，是为了和输入框的受控语义一致
      // （逗号分隔，失焦才规范化）。空串 = 不限制。
      const [editEfforts, setEditEfforts] = React.useState('')
      const [editDefaultEffort, setEditDefaultEffort] = React.useState('')
      // 「只暴露自定义模型」开关（customOnly）：世界可见范围，全局一项而非每个模型一项，
      // 所以放在本页顶部而不是每行里。null 表示还没读到。
      const [customOnly, setCustomOnly] = React.useState(null)

      const reload = React.useCallback(async () => {
        const [list, cand, conf] = await Promise.all([
          rpcRef.current('customModels/list', {}),
          rpcRef.current('customModels/candidates', {}),
          rpcRef.current('config/get', {}),
        ])
        setModels(list.models ?? [])
        setCandidates(cand.models ?? [])
        setCustomOnly(conf?.customOnly === true)
      }, [])

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const [list, cand, conf] = await Promise.all([
              rpcRef.current('customModels/list', {}),
              rpcRef.current('customModels/candidates', {}),
              rpcRef.current('config/get', {}),
            ])
            if (cancelled) return
            setModels(list.models ?? [])
            setCandidates(cand.models ?? [])
            setCustomOnly(conf?.customOnly === true)
          } catch (error) {
            if (!cancelled) {
              setModels([])
              setNotice({ tone: 'error', text: error.message })
            }
          }
        })()
        return () => {
          cancelled = true
        }
      }, [])

      /** 统一的动作包装：置忙、捕获错误、成功后刷新。 */
      const run = async (fn, okText) => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          await reload()
          if (okText !== undefined) setNotice({ tone: 'ok', text: okText })
        } catch (error) {
          setNotice({ tone: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }

      if (models === null) return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取自定义模型中…')

      const move = (list, index, delta) => {
        const next = list.slice()
        const target = index + delta
        if (target < 0 || target >= next.length) return next
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        return next
      }

      const addBinding = (list, setter) => {
        if (pick.length === 0) return
        if (list.includes(pick)) {
          setNotice({ tone: 'warn', text: `「${pick}」已在绑定列表中` })
          return
        }
        setter([...list, pick])
        setPick('')
      }

      // 绑定候选**按 provider 大类分组**再选具体模型。
      //
      // 为什么必须分组：候选是全局铺平的（十几个 provider × 每个几十个模型），
      // 一个平铺下拉里翻找"我要的那个 DeepSeek"等于大海捞针；而且
      // 同一个模型名在不同 provider 下可能都存在，平铺时肉眼分不出区别。
      // 用 <optgroup> 后先定位大类、再定位模型，且组标签直接显示 provider 名。
      //
      // 组内排序按模型公开名；组间排序按 provider 显示名，
      // 保证同一份数据每次渲染顺序稳定（否则刷新一次位置就变，非常难用）。
      const bindingOptions = candidates.length === 0
        ? null
        : (() => {
            const groups = new Map()
            for (const c of candidates) {
              const key = c.provider ?? 'unknown'
              let bucket = groups.get(key)
              if (bucket === undefined) {
                bucket = { label: c.providerName ?? key, items: [] }
                groups.set(key, bucket)
              }
              bucket.items.push(c)
            }
            const ordered = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
            const nodes = []
            for (const g of ordered) {
              g.items.sort((a, b) => a.publicName.localeCompare(b.publicName))
              nodes.push(
                h(
                  'optgroup',
                  { key: `g:${g.label}`, label: `${g.label}（${g.items.length}）` },
                  g.items.map((c) =>
                    h(
                      'option',
                      { key: c.publicName, value: c.publicName },
                      // 组已经表明 provider，行内就**不再重复 @slug**，
                      // 只显示模型名 + 可读名，避免窄下拉里被截断。
                      `${c.model ?? c.publicName}${c.name && c.name !== c.model ? ` — ${c.name}` : ''}`,
                    ),
                  ),
                ),
              )
            }
            return nodes
          })()

      return h(
        'div',
        null,
        h(Notice, { tone: 'info' },
          '自定义模型是一个虚拟模型名：客户端填这个名字发请求，网关按下面的绑定顺序逐个尝试，' +
          '第一个出字的后端就赢。顺序即优先级，用 ↑ ↓ 调整。'),

        // ---------- 对外暴露范围 ----------
        //
        // customOnly 是**全局闸门**，不是每个模型各自的属性，所以单独一块放在最上面。
        // 同时要讲清"为什么打开后 /v1/models 只剩这些"——否则用户会以为真实模型丢了。
        h(
          'div',
          { className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '对外暴露范围'),
          h(
            'label',
            { className: cx('checkRow'), style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '4px' }, title: '关掉后，所有真实模型也会出现在 /v1/models 里并可被调用' },
            h('input', {
              type: 'checkbox',
              checked: customOnly === true,
              disabled: busy || customOnly === null,
              onChange: (e) => {
                const next = e.target.checked
                void run(async () => {
                  await rpcRef.current('config/set', { config: { customOnly: next } })
                  setCustomOnly(next)
                }, next ? '已开启：只暴露自定义模型' : '已关闭：真实模型也可被调用')
              },
            }),
            h('span', null, '只暴露自定义模型'),
            h('span', { className: cx('muted') },
              customOnly === true
                ? '（当前：/v1/models 只列出自定义模型，对话与媒体端点里的其它模型名一律拒绝）'
                : '（当前：真实模型也会列出并可直接调用）'),
          ),
        ),

        // ---------- 新建 ----------
        // #228：折叠 —— 这是"偶尔才用一次"的表单，默认收起让首屏先看到模型列表。
        h(
          'details',
          { className: cx('section', 'collapsible'), open: undefined },
          h('summary', { className: cx('sectionTitle') }, '新建自定义模型'),
          h('p', { className: cx('sectionHint') },
            '模型名只能含字母、数字、下划线、点、连字符、斜杠，且不能带 @（@ 是真实公开名的分隔符）。'),
          h(
            'div',
            { className: cx('row') },
            h('input', {
              className: cx('input'),
              placeholder: '模型名，如 my-model',
              value: draftName,
              disabled: busy,
              onChange: (e) => setDraftName(e.target.value),
            }),
            h('input', {
              className: cx('input'),
              placeholder: '显示名（可留空）',
              value: draftDisplay,
              disabled: busy,
              onChange: (e) => setDraftDisplay(e.target.value),
            }),
          ),
          // 新建区**不再放下拉栏**（用户要求）：创建只负责"起个名字"，
          // 绑定一律在下面每个模型的编辑区里做。理由：新建时还没想好链怎么排，
          // 逼着人当场选后端，等于把编辑动作前移；而真正要调顺序时又得再翻回编辑器。
          // 两步分开后，"先建名、后配链"这条路径更短。
          h('p', { className: cx('muted'), style: { marginTop: '8px' } },
            '创建后到下方列表里点「编辑」添加绑定后端，顺序即故障转移优先级。'),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '10px' } },
            h('button', {
              className: cx('btn', 'btnPrimary'),
              type: 'button',
              disabled: busy || draftName.trim().length === 0,
              onClick: () => run(async () => {
                await rpcRef.current('customModels/create', {
                  name: draftName.trim(),
                  display: draftDisplay.trim(),
                  bindings: [],
                })
                setDraftName('')
                setDraftDisplay('')
              }, '已创建'),
            }, '创建'),
          ),
          h(Inline, { notice }),
        ),

        // ---------- 列表 ----------
        models.length === 0
          ? h('div', { className: cx('empty') }, '还没有自定义模型。创建一个，把多个后端串成一条故障转移链。')
          : models.map((m) => {
              const open = openId === m.id
              const statusMap = new Map((m.bindingStatus ?? []).map((s) => [s.binding, s]))
              const list = open ? editBindings : m.bindings
              return h(
                'div',
                { key: m.id, className: cx('section') },
                h(
                  'h3',
                  { className: cx('sectionTitle') },
                  h('span', { className: cx('mono') }, m.name),
                  h('span', { className: cx('row') },
                    m.enabled ? h(Pill, { tone: 'on' }, '启用中') : h(Pill, { tone: 'off' }, '已停用'),
                    h('span', { className: cx('muted') }, `${m.bindings.length} 个绑定`),
                  ),
                ),
                m.display && m.display !== m.name ? h('p', { className: cx('sectionHint') }, m.display) : null,

                // 绑定链（闭合状态也展示，方便一眼看出优先级）
                list.length === 0
                  ? h('p', { className: cx('muted') }, '没有绑定后端，调用这个模型会直接返回 503。')
                  : h('div', { className: cx('bindList') },
                      list.map((b, i) =>
                        h(BindingRow, {
                          key: b,
                          binding: b,
                          index: i,
                          total: list.length,
                          status: statusMap.get(b),
                          onMove: open ? (idx, d) => setEditBindings(move(editBindings, idx, d)) : () => {},
                          onRemove: open ? (idx) => setEditBindings(editBindings.filter((_, k) => k !== idx)) : () => {},
                        }),
                      ),
                    ),

                open
                  ? h(
                      'div',
                      { style: { marginTop: '10px' } },
                      // ---------- 改名（模型名 + 显示名） ----------
                      // 放在绑定链**之前**：名字是这个模型对外的身份，比"链怎么排"
                      // 更靠前。改模型名要谨慎，所以文案里明说"客户端得跟着改"。
                      h(
                        'div',
                        { className: cx('row'), style: { marginTop: '2px' } },
                        h('label', { className: cx('muted'), style: { minWidth: '108px' } }, '模型名'),
                        h('input', {
                          className: cx('input'),
                          value: editName,
                          disabled: busy,
                          placeholder: '客户端调用时填的名字',
                          onChange: (e) => setEditName(e.target.value),
                        }),
                        h('label', { className: cx('muted'), style: { minWidth: '60px' } }, '显示名'),
                        h('input', {
                          className: cx('input'),
                          value: editDisplay,
                          disabled: busy,
                          placeholder: '可留空',
                          onChange: (e) => setEditDisplay(e.target.value),
                        }),
                      ),
                      h('p', { className: cx('sectionHint') },
                        '模型名就是客户端在 model 字段里填的那个名字（只能含字母、数字、下划线、点、连字符、斜杠，不能带 @）。',
                        '改名后旧名字立刻失效，已经用旧名字的客户端要同步改；链上的绑定和后端不受影响。'),
                      h(
                        'div',
                        { className: cx('row') },
                        h('select', {
                          className: cx('select'),
                          value: pick,
                          disabled: busy || candidates.length === 0,
                          onChange: (e) => setPick(e.target.value),
                        },
                          h('option', { value: '' }, '选择要绑定的模型…'),
                          bindingOptions,
                        ),
                        h('button', {
                          className: cx('btn'),
                          type: 'button',
                          disabled: busy || pick.length === 0,
                          onClick: () => addBinding(editBindings, setEditBindings),
                        }, '＋ 添加绑定'),
                      ),
                      // ---------- 故障转移调优（每个模型各自一份） ----------
                      // 两个数都属"调优参数"：填错不该拦保存，服务端会收敛到合法区间，
                      // 所以这里只做 type=number 的软引导，不加前端校验。
                      h(
                        'div',
                        { style: { marginTop: '12px' } },
                        h('div', { className: cx('row') },
                          h('label', { className: cx('muted'), style: { minWidth: '108px' } }, '后端超时（毫秒）'),
                          h('input', {
                            className: cx('input'),
                            type: 'number',
                            min: 1000,
                            max: 600000,
                            step: 1000,
                            value: editTimeoutMs,
                            disabled: busy,
                            onChange: (e) => setEditTimeoutMs(e.target.value),
                          }),
                          h('label', { className: cx('muted'), style: { minWidth: '84px' } }, '重试次数'),
                          h('input', {
                            className: cx('input'),
                            type: 'number',
                            min: 0,
                            max: 5,
                            step: 1,
                            value: editRetries,
                            disabled: busy,
                            onChange: (e) => setEditRetries(e.target.value),
                          }),
                        ),
                        h('p', { className: cx('muted'), style: { marginTop: '6px' } },
                          '后端超时：一个绑定超过这个时间还没吐出第一个字，就判定卡死并切到下一个；',
                          '生成中途卡住同样计时（只要还在持续吐字就不会被打断）。',
                          '0 = 不设超时（只适合已知很慢的后端）。',
                          '重试次数：整条链上最多再补试几次（0–5）；超时不重试，直接切下一个。',
                          '两者默认 30000 毫秒 / 2 次。'),
                      ),
                      // ---------- 推理档位（第十轮 #118）----------
                      // 这是"推理等级能设置、能自定义"的入口。三件事一起做：
                      //   · 限定这条模型只开放哪几档（白名单，空 = 不限制）
                      //   · 调用方不传时用哪一档（默认档）
                      //   · 把关系统一在四档上（minimal/low/medium/high），
                      //     管理员写 xhigh 也会被服务端归一成 high
                      h(
                        'div',
                        { style: { marginTop: '12px' } },
                        h('div', { className: cx('row') },
                          h('label', { className: cx('muted'), style: { minWidth: '108px' } }, '开放推理档位'),
                          h('input', {
                            className: cx('input'),
                            type: 'text',
                            placeholder: '留空 = 不限制；例如 low,high',
                            value: editEfforts,
                            disabled: busy,
                            onChange: (e) => setEditEfforts(e.target.value),
                          }),
                          h('label', { className: cx('muted'), style: { minWidth: '84px' } }, '默认档'),
                          h('input', {
                            className: cx('input'),
                            type: 'text',
                            placeholder: '留空 = 不干预',
                            value: editDefaultEffort,
                            disabled: busy,
                            onChange: (e) => setEditDefaultEffort(e.target.value),
                          }),
                        ),
                        h('p', { className: cx('muted'), style: { marginTop: '6px' } },
                          '对外只认四档，且它们是**相对位置**而不是词名：',
                          'minimal（关掉思考）/ low（该家偏弱的那档）/ medium（该家居中那档）/ max（该家**最强**的那档）。',
                          '所以选 max 时：后端词表是 [none,low,medium,high,xhigh] 就发 xhigh，',
                          '是 [light,high,extra_high] 就发 extra_high —— 永远拿到它自家的天花板。',
                          '也接受各家的原词（off、light、high、xhigh、extra_high、max），会自动归一。',
                          '「开放推理档位」非空时，调用方传了不在列表里的档会直接 400 并给出可选值（硬拒绝，不静默降档）。',
                          '「默认档」只在调用方完全不传 reasoning_effort 时生效；留空表示不干预、用上游自己的默认。',
                          '默认档必须落在这个白名单里，否则保存时会被自动剔除（避免"按默认档走却被自己拒掉"）。'),
                      ),
                      h(
                        'div',
                        { className: cx('row'), style: { marginTop: '10px' } },
                        h('button', {
                          className: cx('btn', 'btnPrimary'),
                          type: 'button',
                          disabled: busy,
                          onClick: () => {
                            // 这三个值必须在 `run()` **外面**算：
                            // `run(fn, okText)` 的第二个实参（成功文案）要在同一层读到
                            // namePatch，写进 `run(async () => {...})` 里就出了作用域。
                            // 早先正是写成那样，整个保存按钮一点就抛
                            // `ReferenceError: namePatch is not defined`——按钮看得见、
                            // 点得动、什么都不会发生，比报错还难查。
                            //
                            // 名字只在**改过**时才发：`customModels/update` 对 name 会做
                            // 字符集/长度/重名校验，把没动过的原值再发一遍没有副作用，
                            // 但如果用户把输入框清空了（`''`），发过去就会撞上「长度 1–64」
                            // 的报错。清空 = 不改，这个语义由前端兜住。
                            const nextName = editName.trim()
                            const namePatch = nextName.length > 0 && nextName !== m.name ? { name: nextName } : {}
                            // 显示名默认跟着模型名走：只有「显示名还停在旧模型名上」（= 从没单独起过）
                            // 才跟着改名一起换。用户自己起过的显示名（如「主力·快速」）必须原样保留。
                            // 少了这一句，改名后列表和下拉里显示的仍是旧名字，用户会以为没生效。
                            const nextDisplay = editDisplay.trim()
                            const displayPatch = namePatch.name !== undefined && nextDisplay === m.name
                              ? namePatch.name
                              : nextDisplay
                            void run(async () => {
                              await rpcRef.current('customModels/update', {
                                id: m.id,
                                ...namePatch,
                                display: displayPatch,
                                bindings: editBindings,
                                timeoutMs: Number(editTimeoutMs),
                                retries: Number(editRetries),
                                // 推理档位（第十轮 #118）：**始终发**，空串代表"清空该限制"。
                                //
                                // 只在不空时才发会让"取消白名单"永远做不到 ——
                                // 这与 apiKey 那条（40）是同一个坑：`!== undefined` 就写入，
                                // 前端却只在非空时才发，于是"清空"变成了"没发"。
                                reasoningEfforts: editEfforts,
                                defaultReasoningEffort: editDefaultEffort,
                              })
                              // 保存成功后把编辑区**自己也**同步到新值：
                              // `run()` 里的 `reload()` 只刷新列表数据，`editName` / `editDisplay`
                              // 是独立的 state，不跟着变。于是列表已经显示新名字，编辑区还停在
                              // 旧值上——用户盯着输入框会以为"没保存成功"，再点一次又是一遍。
                              // 服务端对空 display 的处理是回落到 name，这里跟着对齐，
                              // 否则界面上会留一个空框，和实际落盘的值不一致。
                              const savedName = namePatch.name ?? m.name
                              setEditName(savedName)
                              setEditDisplay(displayPatch.length > 0 ? displayPatch : savedName)
                            }, namePatch.name === undefined ? '已保存' : '已改名（客户端记得同步改 model 字段）')
                          },
                        }, '保存'),
                        h('button', {
                          className: cx('btn'),
                          type: 'button',
                          disabled: busy,
                          onClick: () => run(async () => {
                            await rpcRef.current('customModels/update', { id: m.id, enabled: !m.enabled })
                          }, m.enabled ? '已停用' : '已启用'),
                        }, m.enabled ? '停用' : '启用'),
                        h('button', {
                          className: cx('btn'),
                          type: 'button',
                          disabled: busy || m.bindings.length === 0,
                          onClick: () => {
                            setBusy(true)
                            setTested(null)
                            setNotice(null)
                            void (async () => {
                              try {
                                const r = await rpcRef.current('customModels/test', { id: m.id })
                                setTested(r)
                              } catch (error) {
                                setNotice({ tone: 'error', text: error.message })
                              } finally {
                                setBusy(false)
                              }
                            })()
                          },
                        }, '逐个实测'),
                        h('button', {
                          className: cx('btn', 'btnDanger'),
                          type: 'button',
                          disabled: busy,
                          onClick: () => {
                            if (!window.confirm(`删除自定义模型「${m.name}」？此操作不可撤销。`)) return
                            void run(async () => {
                              await rpcRef.current('customModels/remove', { id: m.id })
                              setOpenId(null)
                            }, '已删除')
                          },
                        }, '删除'),
                      ),
                      tested && tested.id === m.id
                        ? h(
                            'div',
                            { className: cx('bindList'), style: { marginTop: '10px' } },
                            (tested.results ?? []).map((r) =>
                              h(
                                'div',
                                { key: r.binding, className: cx('bindRow') },
                                h('span', { className: cx('bindOrder') }, r.ok ? '✓' : '✕'),
                                h('span', { className: cx('bindName'), title: r.binding }, h('code', { className: cx('mono') }, r.binding)),
                                h('span', { className: r.ok ? cx('green') : cx('red') },
                                  r.ok
                                    ? `${r.latencyMs} ms`
                                    : r.kind === 'timeout'
                                      ? 'time out'
                                      : (r.reason ?? r.raw ?? r.code ?? '失败')),
                              ),
                            ),
                          )
                        : null,
                      h(Inline, { notice }),
                    )
                  : null,

                h(
                  'div',
                  { className: cx('row'), style: { marginTop: '10px' } },
                  h('button', {
                    className: cx('btn'),
                    type: 'button',
                    onClick: () => {
                      if (open) {
                        setOpenId(null)
                      } else {
                        setOpenId(m.id)
                        setEditBindings(m.bindings.slice())
                        setEditTimeoutMs(String(m.timeoutMs ?? 30000))
                        setEditRetries(String(m.retries ?? 2))
                        setEditName(m.name)
                        setEditDisplay(m.display ?? '')
                        // 档位白名单回填：数组 → 逗号分隔串（空数组 = 不限制）
                        setEditEfforts(Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.join(',') : '')
                        setEditDefaultEffort(typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : '')
                        setTested(null)
                        setNotice(null)
                        setPick('')
                      }
                    },
                  }, open ? '收起' : '编辑'),
                ),
              )
            }),
      )
    }

    // ────────────────────────────── 自定义工具（生图 / 生视频 / 其它） ──────────────────────────────

    /** 工具种类的显示名。 */
    const TOOL_KIND_LABEL = { image: '生图', video: '生视频', other: '其它' }

    /**
     * 工具种类 → "这个 kind 会出现在哪些请求里"。
     *
     * 必须写出来：kind 不是装饰，它决定这条工具被暴露到哪一族端点。
     * 用户选错 kind 的后果是"配好了却调不到"，而症状（404 model_not_allowed）
     * 完全看不出是 kind 选错，所以解释要贴在选择框旁边，不能只写在文档里。
     */
    const TOOL_KIND_HINT = {
      image: '写在 /v1/images/generations 或 /v1/images/edits 的 model 里',
      video: '写在 /v1/videos 系列端点的 model 里',
      other: '调用 POST /v1/tools/<工具名>，请求体原样交给宿主工具',
    }

    /**
     * 把宿主工具的 `parameters`（JSON Schema）摊平成"能直接渲染成表单"的字段描述。
     *
     * 只取第一层 properties：宿主工具的入参全是扁平的对象（没有嵌套的 oneOf / anyOf），
     * 真遇到嵌套就留给高级 JSON 模式，而不是在这里猜一个半对不错的结构。
     * 拿不到 schema（工具没注册 / 老版本宿主不给 parameters）时返回空数组，
     * 调用方据此退回 JSON textarea——**不能因为读不到 schema 就把这一栏整个删掉**，
     * 那样会让原本配好固定参数的人无从修改。
     *
     * @param schema - 工具定义里的 parameters。
     * @returns 字段描述数组：`{ key, label, type, required, hint, enumValues, defaultValue }`。
     */
    const paramFieldsOf = (schema) => {
      const properties = schema?.properties
      if (properties === null || typeof properties !== 'object') return []
      const required = Array.isArray(schema?.required) ? schema.required : []
      return Object.keys(properties).map((key) => {
        const def = properties[key]
        const type = typeof def?.type === 'string' ? def.type : 'string'
        const enumValues = Array.isArray(def?.enum) ? def.enum : undefined
        return {
          key,
          label: typeof def?.title === 'string' && def.title.length > 0 ? def.title : key,
          type,
          required: required.includes(key),
          hint: typeof def?.description === 'string' ? def.description : '',
          enumValues,
          defaultValue: def?.default,
        }
      })
    }

    /**
     * 平台注入声明：本插件需要 `slots`（挂设置面板）和 `connection`（走 RPC）。
     *
     * ⚠ #229：这一行在 #226 删死代码时被**误删**了 —— 它在删除区间的最后一行
     * （`var inject = [...]` 正好紧邻 `apply` 上方，被连带切掉）。
     * 后果是加载时 `inject is not defined`，整个插件起不来：
     *   "本页面的插件未能完成同步；服务端的启用状态保持不变"
     * 教训：按行号区间删除时，区间**两端**的邻接行必须逐行核对语义，
     *       不能只看"看起来是死代码的边界"。
     */
    var inject = ['slots', 'connection']

    /**
     * 插件入口：注册样式与设置面板。
     *
     * #226：这里原本挂着「自定义工具页」的 JSDoc —— 那个组件在 #194 下线媒体
     * / 自定义工具时就成了死代码，本轮（#226）把组件本体删掉了，
     * 但它的注释块留在了 apply 上面，读起来像是 apply 在描述工具页。
     * 一并清理，避免误导。
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'lantern: install styles')

      const rpcCall = async (method, payload) => {
        const raw = await ctx.connection.rpc.call('/api', ENDPOINT, { method, payload })
        return unwrap(raw)
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'lantern',
            order: 40,
            label: () => 'LANtern',
            inject: () => ({ rpc: rpcCall }),
          },
          LanternPage,
        ),
      )
    }

    module.exports = { apply, inject, name: 'lantern-client' }
    return module.exports
  },
})
