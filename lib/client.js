window.__ModuleLoader__.load({
  id: '@5115qwq/dsh-lantern',
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
    /* ── 模型行（ProviderPage）──────────────────────────────────────── */
    /* 主标题是人话名 + 徽章，原始标识降级为灰字副行。 */
    .dim-lt-modelNameRow {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .dim-lt-modelName {
      font-size: 13px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    .dim-lt-modelIdLine {
      margin-top: 2px;
    }
    .dim-lt-modelIdText {
      font-size: 11px;
      color: var(--dsw-alias-label-primary, #1f2328);
      user-select: text;
    }
    .dim-lt-modelDesc {
      margin-top: 4px;
      font-size: 11px;
      color: var(--dsw-alias-label-primary, #1f2328);
    }

    /* ── 自定义下拉（ModelPicker）────────────────────────────────────── */
    .dim-lt-picker {
      position: relative;
      flex: 1 1 320px;
      min-width: 240px;
    }
    .dim-lt-pickerTrigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-height: 42px;
      padding: 6px 10px;
      text-align: left;
      cursor: pointer;
      background: var(--dsw-alias-bg-layer-3, #fff);
      border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
      border-radius: 6px;
      font: inherit;
      color: inherit;
    }
    .dim-lt-pickerTrigger:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .dim-lt-pickerOpen {
      border-color: var(--dsw-alias-brand-primary, #0969da);
    }
    .dim-lt-pickerTriggerBody {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1 1 auto;
    }
    .dim-lt-pickerPlaceholder {
      font-size: 12px;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    .dim-lt-pickerCaret {
      flex: 0 0 auto;
      font-size: 10px;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    .dim-lt-pickerNameRow {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      line-height: 1.3;
    }
    .dim-lt-pickerName {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    .dim-lt-pickerId {
      display: block;
      margin-top: 2px;
      font-size: 10.5px;
      color: var(--dsw-alias-label-primary, #1f2328);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .dim-lt-pickerMenu {
      position: absolute;
      z-index: 50;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 320px;
      overflow-y: auto;
      padding: 4px;
      background: var(--dsw-alias-bg-layer-2, #fff);
      border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    }

    /* 靠近视口底部时向上展开（由 JS 量可用空间后加类名）。 */
    .dim-lt-pickerMenuUp {
      top: auto;
      bottom: calc(100% + 4px);
    }

    /* ── 下拉搜索框 ────────────────────────────────────────────────── */
    /* 固定在菜单顶部：候选多时滚动列表，搜索框始终可用。 */
    .dim-lt-pickerSearchWrap {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 4px 6px;
      background: var(--dsw-alias-bg-layer-2, #fff);
    }
    .dim-lt-pickerSearch {
      flex: 1 1 auto;
      min-width: 0;
      /* 复用 .dim-lt-input 的基础样式，这里只补自己的 */
      font-size: 12px;
      height: 28px;
    }
    /* Safari/Chrome 的 search 取消按钮与我们的 ✕ 重复，去掉原生的 */
    .dim-lt-pickerSearch::-webkit-search-cancel-button {
      display: none;
    }
    .dim-lt-pickerSearchClear {
      flex: 0 0 auto;
    }
    /* ── 拖拽排序 ─────────────────────────────────────────────────── */
    /* 拖拽手柄：平时不占位，悬停整行时才出现。
       用绝对定位 + opacity 过渡，避免 2px 的图标撑出空白。 */
    .dim-lt-bindHandle {
      position: absolute;
      left: -2px;
      top: 50%;
      width: 10px;
      height: 16px;
      margin-top: -8px;
      background-image: radial-gradient(circle, var(--dsw-alias-label-tertiary, #8b949e) 1px, transparent 1px);
      background-size: 4px 4px;
      background-position: center;
      border-radius: 2px;
      opacity: 0;
      cursor: grab;
      transition: opacity 0.12s;
    }
    .dim-lt-bindRow:hover .dim-lt-bindHandle {
      opacity: 0.45;
    }
    .dim-lt-bindRow:hover .dim-lt-bindHandle:hover {
      opacity: 0.9;
    }
    .dim-lt-bindHandle:active {
      cursor: grabbing;
    }
    /* bindRow 要 relative，手柄才能绝对定位 */
    .dim-lt-bindRow {
      position: relative;
    }
    /* 拖起的那一行压低透明度，表示"正在搬它" */
    .dim-lt-bindRowDragging {
      opacity: 0.45;
    }
    /* 目标位置的插入指示线：让"会插到哪"一眼可见 */
    .dim-lt-bindRowDropTarget {
      box-shadow: inset 0 2px 0 0 var(--dsw-alias-brand-primary, #1677ff);
    }

    /* ── 加入自定义模型弹窗 ──────────────────────────────────────── */
    .dim-lt-addPickList {
      max-height: 320px;
      overflow-y: auto;
      border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
      border-radius: 8px;
      padding: 4px;
      margin-top: 4px;
    }
    .dim-lt-addPickRow {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 6px;
      cursor: pointer;
    }
    .dim-lt-addPickRow:hover {
      background: var(--dsw-alias-bg-layer-4, #f3f4f6);
    }
    /* 已在目标链里的行：变淡 + 不可选，但仍可见（用户要知道哪些加过了） */
    .dim-lt-addPickRowDone {
      opacity: 0.55;
      cursor: default;
    }
    .dim-lt-addPickBody {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .dim-lt-addPickNameRow {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .dim-lt-addPickName {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    .dim-lt-addPickId {
      font-size: 10.5px;
      color: var(--dsw-alias-label-tertiary, #8b949e);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── 常驻绑定选择器 ──────────────────────────────────────────── */
    /* 在绑定列表正下方，始终可见，不必先点「编辑」。 */
    .dim-lt-bindPickerWrap {
      margin-top: 8px;
    }

    /* ── 提示行（左侧文案 + 右侧批量按钮）────────────────────────── */
    .dim-lt-pickerHintRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 8px 4px;
    }
    /* 轻量按钮：批量操作用文字链接样式，不抢主按钮的视觉重量 */
    .dim-lt-linkBtn {
      flex: 0 0 auto;
      padding: 0 2px;
      font-size: 10.5px;
      color: var(--dsw-alias-brand-primary, #1677ff);
      background: none;
      border: 0;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .dim-lt-linkBtn:hover {
      opacity: 0.75;
    }

    /* 菜单顶部的操作提示：一句话说明"点一下就能加/减" */
    .dim-lt-pickerHint {
      padding: 2px 8px 4px;
      font-size: 10.5px;
      color: var(--dsw-alias-label-tertiary, #8b949e);
    }
    .dim-lt-pickerEmpty {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 16px 12px;
      text-align: center;
      font-size: 12px;
      color: var(--dsw-alias-label-tertiary, #8b949e);
    }
    .dim-lt-pickerEmptyHint {
      font-size: 11px;
      opacity: 0.85;
    }

    /* ── 绑定行：人话名 + 标识两层 ──────────────────────────────────── */
    /* 只显示 <model>@<provider> 时，一串高度相似的标识分不清谁是谁。 */
    .dim-lt-bindNameMain {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      flex-wrap: wrap;
    }
    .dim-lt-bindTitle {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, #1f2328);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 第二层：标识 + 状态标签，同行排列 */
    /* bindName 内部纵向两层（用更高特异性覆盖基础规则） */
    .dim-lt-bindList .dim-lt-bindName {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }
    .dim-lt-bindMeta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
    }
    /* 有主标题时，标识降级为副行：更小、更淡 */
    .dim-lt-bindName .dim-lt-bindIdSub {
      font-size: 10.5px;
      color: var(--dsw-alias-label-tertiary, #8b949e);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dim-lt-pickerGroup + .dim-lt-pickerGroup {
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
    }
    .dim-lt-pickerGroupLabel {
      padding: 4px 8px 2px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--dsw-alias-label-primary, #1f2328);
    }
    /* 已启用分组：用绿色标签把它和普通 provider 组区分开 */
    .dim-lt-pickerGroupLabelPinned {
      color: #389e0d;
    }

    .dim-lt-pickerItem {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      text-align: left;
      cursor: pointer;
      background: none;
      border: 0;
      border-radius: 6px;
      font: inherit;
      color: inherit;
    }
    .dim-lt-pickerItem:hover {
      background: var(--dsw-alias-bg-layer-4, #f3f4f6);
    }
    .dim-lt-pickerItemActive {
      background: var(--dsw-alias-bg-layer-4, #eef4ff);
    }
    .dim-lt-pickerItemBody {
      flex: 1 1 auto;
      min-width: 0;
    }
    .dim-lt-pickerCheck {
      flex: 0 0 auto;
      font-size: 12px;
      font-weight: 700;
      color: #389e0d;
    }

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
    /* ── 逐条测速结果行（每个绑定一行）──────────────────────────────── */
    /* ⚠ 不要复用 .bindName：它是纵向两层的容器（模型名 + 标识），
       用在测速行上会给这行引入 flex-direction: column，
       把右侧的 "1817 ms" 挤到第二行。 */
    /* ⚠ 必须用 .dim-lt-bindRow.dim-lt-bindRowTest 两级选择器：
       .dim-lt-bindRow 的 grid-template-columns（两列）在样式表里
       定义得更靠后，同优先级会覆盖这里，导致 ms 被挤下去。 */
    .dim-lt-bindRow.dim-lt-bindRowTest {
      grid-template-columns: 20px minmax(0, 1fr) auto;
    }
    .dim-lt-bindTestName {
      display: flex;
      align-items: center;
      min-width: 0;
      overflow: hidden;
    }
    /* 失败原因可能很长（上游错误 / 超时说明）：限宽 + 省略号，
       完整文本在 title 里悬停可见。通过态不受影响。 */
    .dim-lt-bindTestMs.dim-lt-red {
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dim-lt-bindTestName > code {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 失效绑定的移除按钮：紧跟「失效」药丸，不占额外高度 */
    .dim-lt-bindRemoveBtn {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      padding: 0;
      font-size: 11px;
      line-height: 1;
    }

    .dim-lt-bindTestMs {
      /* ⚠ 不能设 max-width + text-overflow: ellipsis —— 那会把
         "1783 ms" 截成 "1…"（实测就长这样）。这一列本来就短（毫秒数
         几位数而已），让它自然撑开即可，被压缩的应该是左边的绑定名。 */
      flex: 0 0 auto;
      white-space: nowrap;
      text-align: right;
    }

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
.dim-lt-bindRow { position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-layer-3, #fff); }
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

    /**
     * 模型选择下拉（自定义，不是 <select>）。
     *
     * ## 为什么不用原生 <select>
     *
     * 原生 <option> 只能放**纯文本**，无法：
     *   · 做两行（人话名在上、原始标识在下）
     *   · 跟在名字后面放徽章（倍率「最低 x0.2」等）
     *   · 给已绑定的项打「已启用」标记
     *
     * 而这些恰好是用户反馈的核心困惑：「列表里全是 qwenwork/deepseek-flash
     * 这种标识，分不清哪条是哪条」。
     *
     * ## 布局
     *
     *   第一行：千问办公国际版 · DeepSeek-V4.1-Flash  [最低 x0.2] [已启用]
     *   第二行：qwenwork-intl/deepseek-flash@channel-hub
     *
     * ## 交互
     *
     * 点击展开 → 点某项 → 选中并收起；点外部 / Esc 收起。
     * provider 分组标题只读。
     */
    function ModelPicker(props) {
      const { groups, bound, disabled, emptyText, onChange, onBulkAdd } = props
      const [open, setOpen] = React.useState(false)
      // 菜单默认向下展开；靠近视口底部时向上翻，否则会被裁掉。
      const [dropUp, setDropUp] = React.useState(false)
      // 搜索词：候选是「十几个 provider × 每个几十个模型」的全局铺平列表，
      // 26 个模型就能滚很久，100+ 个时纯靠翻找完全不可用。
      const [query, setQuery] = React.useState('')
      const rootRef = React.useRef(null)
      const searchRef = React.useRef(null)
      // 菜单滚动位置：菜单随 open 一起卸载重建，不记住就会回到顶部。
      const menuRef = React.useRef(null)
      const scrollRef = React.useRef(0)

      // 菜单重新挂载后把滚动位置放回去。
      // 用 useLayoutEffect（而不是 useEffect）在浏览器绘制前恢复，
      // 否则会先显示顶部再跳到目标位置，肉眼能看见闪一下。
      React.useLayoutEffect(() => {
        if (open && menuRef.current !== null && scrollRef.current > 0) {
          menuRef.current.scrollTop = scrollRef.current
        }
      }, [open, query])

      // 点外部收起 + Esc 收起。用 ref 判断"点在不在组件内"。
      React.useEffect(() => {
        if (!open) return undefined
        const onDocDown = (e) => {
          if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      /**
       * 按搜索词过滤分组。
       *
       * 匹配范围（三者任一命中即可）：
       *   · 人话名（name）—— 用户最可能记得的
       *   · 裸模型 id（model）
       *   · 公开名（publicName，含 provider 后缀）
       *
       * 大小写不敏感。空搜索返回原分组（引用不变，避免无谓重渲染）。
       */
      const q = query.trim().toLowerCase()
      const filteredGroups = q.length === 0
        ? groups ?? []
        : (groups ?? [])
            .map((g) => ({
              label: g.label,
              items: g.items.filter((c) => {
                const hay = [c.name, c.model, c.publicName]
                return hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
              }),
            }))
            .filter((g) => g.items.length > 0)

      const totalMatched = filteredGroups.reduce((n, g) => n + g.items.length, 0)

      /**
       * 把已绑定的模型单独拎成一组放到最上面。
       *
       * 没有这一步时要加/减一个已在链上的模型，得在 26 个里往下翻着找 ——
       * 而这恰恰是最频繁的操作（调优先级、临时移除）。
       *
       * 已启用的从原分组里**移除**（不是复制），避免同一个模型出现两次。
       */
      const enabledGroups = (() => {
        if (bound === undefined || bound.size === 0) return filteredGroups
        const enabledItems = []
        const rest = []
        for (const g of filteredGroups) {
          const kept = []
          for (const c of g.items) {
            if (bound.has(c.publicName)) enabledItems.push(c)
            else kept.push(c)
          }
          if (kept.length > 0) rest.push({ label: g.label, items: kept, pinned: false })
        }
        if (enabledItems.length === 0) return filteredGroups
        return [{ label: `已启用 ${enabledItems.length} 个`, items: enabledItems, pinned: true }, ...rest]
      })()

      // 已绑定数量：这是「勾多个」的清单，不是「选一个」的单选。
      // 收起态显示「已绑定 N 个」比显示某个具体模型更贴合现在的语义。
      const boundCount = bound === undefined ? 0 : bound.size

      const hasAny = (groups ?? []).some((g) => g.items.length > 0)

      return h(
        'div',
        { className: cx('picker'), ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: cx('pickerTrigger', open ? 'pickerOpen' : null),
            disabled: disabled || !hasAny,
            onClick: () => {
              if (!open) {
                // 展开前量一次：触发器下方若放不下菜单（约 320px），就向上翻。
                const el = rootRef.current
                if (el !== null) {
                  const rect = el.getBoundingClientRect()
                  const spaceBelow = window.innerHeight - rect.bottom
                  const spaceAbove = rect.top
                  const MENU_MAX = 320
                  setDropUp(spaceBelow < MENU_MAX && spaceAbove > spaceBelow)
                }
                // 每次展开都从空搜索开始：上次的过滤条件留着会让用户
                // 以为"模型变少了"。收起时清空同理。
                setQuery('')
              }
              setOpen((v) => !v)
            },
            title: boundCount === 0 ? emptyText : `已绑定 ${boundCount} 个模型`,
          },
          h(
            'span',
            { className: cx('pickerTriggerBody') },
            boundCount === 0
              ? h('span', { className: cx('pickerPlaceholder') }, emptyText)
              : h(
                  'span',
                  null,
                  h(
                    'span',
                    { className: cx('pickerNameRow') },
                    h('span', { className: cx('pickerName') }, `已绑定 ${boundCount} 个模型`),
                  ),
                  h('code', { className: cx('mono', 'pickerId') }, '点开可继续添加或移除'),
                ),
          ),
          h('span', { className: cx('pickerCaret') }, open ? '▴' : '▾'),
        ),
        open
          ? h(
              'div',
              {
                className: cx('pickerMenu', dropUp ? 'pickerMenuUp' : null),
                role: 'listbox',
                ref: menuRef,
                // 恢复上次的滚动位置：翻到一半点了外部关闭，再打开应该还在原处，
                // 而不是回到顶部让人重新往下拉。
                onScroll: (e) => { scrollRef.current = e.currentTarget.scrollTop },
              },
              // ── 搜索框 ──
              //
              // 候选是「十几个 provider × 每个几十个模型」的全局铺平列表，
              // 26 个就能滚很久，100+ 个时纯靠翻找完全不可用。
              // 搜索框固定在菜单顶部（sticky），滚动列表时始终可用。
              h(
                'div',
                { className: cx('pickerSearchWrap') },
                h('input', {
                  ref: searchRef,
                  className: cx('input', 'pickerSearch'),
                  type: 'search',
                  placeholder: '搜索：中文名 / 模型 id / provider',
                  value: query,
                  autoFocus: true,
                  onChange: (e) => setQuery(e.target.value),
                  // Esc 先清搜索，没有搜索时才收起菜单（否则用户按 Esc
                  // 想清空却把整个菜单关了，非常反直觉）
                  onKeyDown: (e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      if (query.length > 0) setQuery('')
                      else setOpen(false)
                    }
                  },
                }),
                query.length > 0
                  ? h('button', {
                      type: 'button',
                      className: cx('iconBtn', 'pickerSearchClear'),
                      title: '清空搜索',
                      onClick: () => {
                        setQuery('')
                        if (searchRef.current !== null) searchRef.current.focus()
                      },
                    }, '✕')
                  : null,
              ),
              // 搜索提示 + 批量操作
              //
              // 26 个模型想一次加完时，逐个点太慢。批量按钮只在
              // 「有可操作对象」时出现，平时不占位。
              h(
                'div',
                { className: cx('pickerHintRow') },
                h('span', { className: cx('pickerHint') },
                  query.length > 0 && totalMatched > 0
                    ? `匹配 ${totalMatched} 个 · 点一次加入，再点一次移除`
                    : '点一次加入，再点一次移除',
                ),
                // 全加：只对**当前搜索/可见**的模型生效，不是整个池子 ——
                // 用户搜了「deepseek」再点全加，期望的是加这些，不是加 26 个。
                query.length > 0 && totalMatched > 0
                  ? h('button', {
                      type: 'button',
                      className: cx('linkBtn'),
                      title: '把当前搜索结果全部加入绑定链',
                      onClick: () => {
                        if (onBulkAdd === undefined) return
                        onBulkAdd(filteredGroups.flatMap((g) => g.items.map((c) => c.publicName)))
                      },
                    }, '全加')
                  : null,
                boundCount > 0
                  ? h('button', {
                      type: 'button',
                      className: cx('linkBtn'),
                      title: '清空全部绑定',
                      onClick: () => {
                        if (onBulkAdd === undefined) return
                        onBulkAdd([], true)
                      },
                    }, '全清')
                  : null,
              ),
              enabledGroups.map((g) =>
                h(
                  'div',
                  { key: `pg:${g.label}`, className: cx('pickerGroup') },
                  h('div', { className: cx('pickerGroupLabel', g.pinned === true ? 'pickerGroupLabelPinned' : null) }, g.pinned === true ? g.label : `${g.label}（${g.items.length}）`),
                  g.items.map((c) => {
                    const isBound = bound !== undefined && bound.has(c.publicName)
                    return h(
                      'button',
                      {
                        key: c.publicName,
                        type: 'button',
                        role: 'option',
                        'aria-selected': isBound,
                        className: cx('pickerItem', isBound ? 'pickerItemActive' : null),
                        // 点选即切换绑定状态，**不关闭菜单**：
                        // 用户常常要连着加好几个模型，每点一次就收起
                        // 再重新展开是很烦的。关闭交给「点外部」或 Esc。
                        onClick: () => onChange(c.publicName),
                        title: c.publicName,
                      },
                      h(
                        'span',
                        { className: cx('pickerItemBody') },
                        h(
                          'span',
                          { className: cx('pickerNameRow') },
                          nameIsSameAsId(c.name, c.model, c.publicName)
                            ? null
                            : h('span', { className: cx('pickerName') }, c.name),
                          c.badge && c.badge.text
                            ? h(Pill, { tone: c.badge.tone === 'warn' ? 'warn' : 'neutral' }, c.badge.text)
                            : null,
                          isBound
                            ? h(Pill, { tone: 'on', title: '这个模型已经在当前自定义模型的绑定链里' }, '已启用')
                            : null,
                        ),
                        h('code', { className: cx('mono', 'pickerId') }, c.publicName),
                      ),
                      isBound ? h('span', { className: cx('pickerCheck') }, '✓') : null,
                    )
                  }),
                ),
              ),
              // 搜索无结果时的空态：明确告诉用户「是搜不到」而不是「没数据」
              query.trim().length > 0 && totalMatched === 0
                ? h('div', { className: cx('pickerEmpty') },
                    h('span', null, `没有匹配「${query.trim()}」的模型`),
                    h('span', { className: cx('pickerEmptyHint') },
                      '可以搜中文名、模型 id 或 provider 名'),
                  )
                : null,
            )
          : null,
      )
    }


    /**
     * 人话名是否只是「标识的另一种写法」—— 是的话就不该再单独显示一行。
     *
     * 典型情况：name 与 model 完全相同（上游没给可读名，直接回填了 id）。
     *
     * 判据（任一命中即视为「重复」）：
     *   1. name 与 model 完全相同
     *   2. name 与 publicName 完全相同
     *   3. name 大小写 / 分隔符归一后与 model 或 publicName 相同
     *
     * 为什么需要它：模型列表与下拉都是「主标题 + 副行标识」两层布局，
     * name 等于标识时会变成上下两行一模一样的文字，看着像渲染 bug。
     *
     * @param name - 人话名（可能为 undefined）。
     * @param model - 裸模型 id。
     * @param publicName - 公开名（model@provider）。
     * @returns true = 不要单独显示主标题。
     */
    function nameIsSameAsId(name, model, publicName) {
      if (typeof name !== 'string' || name.length === 0) return true
      if (name === model || name === publicName) return true
      const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_./-]+/g, '')
      return norm(name) === norm(model) || norm(name) === norm(publicName)
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
          // 底部按钮区：只在调用方显式给了 footer 时渲染。
          //
          // 不再有「关闭」兜底 —— 现在唯一的弹窗自带「取消 / 确认加入」，
          // 再多一个「关闭」是重复且占位的。模态本身的关闭路径一直有两条：
          // 点遮罩、按 Esc。
          footer ? h('div', { className: cx('modalFoot') }, footer) : null,
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
              // == null 同时覆盖 null 与 undefined：服务端某些汇总可能不带
              // hitRate 字段，只判 null 会算出 NaN 并显示成 "NaN%"。
              hitRate: u.totals.hitRate == null ? '—' : `${(u.totals.hitRate * 100).toFixed(1)}%`,
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

      // ⚠ 这里原来把 loadUsage 也放进了同一个 effect，而 loadUsage 依赖
      // [usageRange] —— 用户切一次「最近 N 天」就会重跑整个 effect：
      // 重发 status / keys / listens / breaker / backendHealth / filters /
      // cors / exposure / storage 共 8 个 RPC，还重建 5s 定时器。
      // 真正需要重取的只有用量，所以拆成两个 effect。
      React.useEffect(() => {
        void refresh()
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
      }, [refresh, loadBreaker, loadBackendHealth, loadFilters, loadCors, loadExposure, loadStorage])

      React.useEffect(() => {
        void loadUsage()
      }, [loadUsage])

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
                  defaultValue: limits.breaker?.consecutiveRateLimits ?? 3,
                  disabled: busy,
                  onBlur: (e) => {
                    const raw = String(e.target.value ?? '').trim()
                    const cur = limits.breaker?.consecutiveRateLimits ?? 3
                    if (raw.length === 0) { e.target.value = String(cur); return }
                    const next = Number(raw)
                    if (!Number.isFinite(next)) { e.target.value = String(cur); return }
                    if (next === cur) return
                    void run(() => rpc('config/set', { config: { limits: { breaker: { consecutiveRateLimits: next } } } }), null, 'limits')
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                  },
                }),
              ),
              h('label', { className: cx('field') },
                h('span', { className: cx('fieldLabel') }, '限流冷却秒数'),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min: 5,
                  max: 600,
                  defaultValue: limits.breaker?.cooldownSec ?? 60,
                  disabled: busy,
                  onBlur: (e) => {
                    const raw = String(e.target.value ?? '').trim()
                    const cur = limits.breaker?.cooldownSec ?? 60
                    if (raw.length === 0) { e.target.value = String(cur); return }
                    const next = Number(raw)
                    if (!Number.isFinite(next)) { e.target.value = String(cur); return }
                    if (next === cur) return
                    void run(() => rpc('config/set', { config: { limits: { breaker: { cooldownSec: next } } } }), null, 'limits')
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                  },
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
                    h('label', { className: cx('cap'), title: '账本是追加流水：删除 Key、下线模型、匿名访问都不会抹掉历史行。\n默认把它们藏起来，避免把历史用量误读成"现在还在用"。' },
                      h('input', {
                        className: cx('checkbox'),
                        type: 'checkbox',
                        checked: showStale,
                        onChange: (e) => setShowStale(e.target.checked),
                      }),
                      '显示历史条目（已删除 / 已下线 / 匿名）',
                    ),
                    (() => {
                      // 统计口径必须与下面两张表的**过滤条件一致**，
                      // 否则会出现「提示说藏了 2 个、展开后却有 3 行」。
                      //
                      // 隐藏条件合并了三类：
                      //   · 已删除的 Key（不在 keyStore 里）
                      //   · 匿名 / 未知来源、面板自己发的内部功能测试
                      //     （这些不是真实用户，未开启匿名访问时不该出现在日常视图）
                      //   · 已下线的模型（当前目录里已经没有）
                      const hiddenKeys = (usage.keys ?? []).filter((k) => k.calls > 0
                        && (k.deleted === true || k.id === 'anonymous' || k.id === 'unknown' || k.id === 'internal')).length
                      const hiddenModels = (usage.models ?? []).filter((m) => m.offline === true).length
                      // 第三张表（Key × 模型）也有自己的隐藏过滤，必须一并计入。
                      // 原来只数前两张，于是「提示说藏了 3 个、展开后多出 29 行」。
                      const hiddenCross = (usage.cross ?? []).filter((x) =>
                        x.deleted === true || x.keyId === 'anonymous' || x.keyId === 'unknown' || x.keyId === 'internal').length
                      const hiddenTotal = hiddenKeys + hiddenModels + hiddenCross
                      const anonUsed = (usage.keys ?? []).some((k) => (k.id === 'anonymous' || k.id === 'internal') && k.calls > 0)
                      if (hiddenTotal === 0) return null
                      return h('span', { className: cx('muted') },
                        `（已隐藏 ${hiddenTotal} 条历史记录，仅历史用量）` +
                          (anonUsed ? ' · 其中含内部功能测试或未带 Key 的请求' : ''))
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
                                h('td', { className: cx('mono') }, x.hitRate == null ? '—' : `${(x.hitRate * 100).toFixed(1)}%`),
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
                            .filter((k) => showStale || (k.deleted !== true && k.id !== 'anonymous' && k.id !== 'unknown' && k.id !== 'internal'))
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
                              h('td', { className: cx('mono') }, k.hitRate == null ? '—' : `${(k.hitRate * 100).toFixed(1)}%`),
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
                            // 与「按 Key」表同一套口径：默认隐藏匿名 / 未知 /
                            // 已删除 Key。交叉表的 model 是上游真实坐标，
                            // 没有「自定义模型是否下线」这个语义，不按模型过滤。
                            // 原来只判 x.offline（服务端根本没设这个字段），
                            // 过滤恒为真 —— 一条都没藏住。
                            .filter((x) => showStale || (
                              x.deleted !== true
                              && x.keyId !== 'anonymous'
                              && x.keyId !== 'unknown'
                              && x.keyId !== 'internal'
                            ))
                            .map((x) =>
                              h('tr', {
                                key: `${x.keyId}\u0000${x.model}`,
                                className: cx(x.deleted === true ? 'rowDeleted' : null),
                              },
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
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                title:
                  '导出一份可迁移的配置快照（只含配置项，不含 API Key、用量账本、能力学习记录）。\n' +
                  '换机或重装时用它对照/复制设置。',
                onClick: () =>
                  run(async () => {
                    const r = await rpc('config/export', {})
                    setNotice({
                      tone: 'ok',
                      text: `已导出配置快照：${r.path}（${r.note}）`,
                      where: 'diag',
                    })
                  }, null, 'diag'),
              },
              '导出配置',
            ),
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
                        ? h('span', { style: { color: '#389e0d' } }, `${(f.bytes / 1024).toFixed(1)}K`)
                        : h('span', { style: { color: '#d4380d' } }, '缺失'),
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
                      h('span', { className: cx('mono'), style: { color: '#d46b08' } }, `${storage.corruptions} 个`),
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
              h('span', { className: cx('fieldLabel') }, '后端冷却秒数'),
              h('input', {
                className: cx('input'),
                type: 'number',
                min: 5,
                max: 600,
                defaultValue: limits.backendHealth?.cooldownSec ?? 30,
                disabled: busy,
                onBlur: (e) => {
                  const raw = String(e.target.value ?? '').trim()
                  const cur = limits.backendHealth?.cooldownSec ?? 30
                  if (raw.length === 0) { e.target.value = String(cur); return }
                  const next = Number(raw)
                  if (!Number.isFinite(next)) { e.target.value = String(cur); return }
                  if (next === cur) return
                  void run(() => rpc('config/set', { config: { limits: { backendHealth: { cooldownSec: next } } } }), null, 'diag')
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                },
              }),
            ),
            h('label', { className: cx('field') },
              h('span', { className: cx('fieldLabel') }, '冷却上限秒数'),
              h('input', {
                className: cx('input'),
                type: 'number',
                min: 5,
                max: 1800,
                defaultValue: limits.backendHealth?.maxCooldownSec ?? 300,
                disabled: busy,
                onBlur: (e) => {
                  const raw = String(e.target.value ?? '').trim()
                  const cur = limits.backendHealth?.maxCooldownSec ?? 300
                  if (raw.length === 0) { e.target.value = String(cur); return }
                  const next = Number(raw)
                  if (!Number.isFinite(next)) { e.target.value = String(cur); return }
                  if (next === cur) return
                  void run(() => rpc('config/set', { config: { limits: { backendHealth: { maxCooldownSec: next } } } }), null, 'diag')
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                },
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
                disabled: busy || listens.length === 0,
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
      // 自定义模型列表：给「加入自定义模型」入口用。
      // 只读不写 —— 改动走 customModels/update，与自定义模型页共用同一个 RPC。
      const [customModels, setCustomModels] = React.useState([])
      // 加入自定义模型弹窗：null = 关闭，否则 { target: 目标模型 id, picked: Set<公开名> }
      const [addDialog, setAddDialog] = React.useState(null)

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
          // 自定义模型列表：给「加入自定义模型」入口用。
          // 拿不到不影响主流程（模型列表照常显示），所以单独 try。
          try {
            const cm = await rpcRef.current('customModels/list', {})
            if (!cancelled) setCustomModels(cm.models ?? [])
          } catch {
            if (!cancelled) setCustomModels([])
          }
        })()
        return () => {
          cancelled = true
        }
      }, [provider.id])

      // 模型列表的重新加载：供「刷新」按钮复用。
      //
      // 为什么需要它：在 Hub 里给这个 provider 新增模型时，provider.id 不变，
      // 下面的 effect 不会重跑 —— 面板会一直显示旧列表，只能关掉重开。
      // 服务端目录已经在 llm/models-updated 到达时重建，这里拉到的就是最新的。
      const reloadModels = React.useCallback(async () => {
        setModels(null)
        setOpenId(null)
        setPerf(null)
        setNotice(null)
        try {
          const r = await rpcRef.current('models/list', { provider: provider.id })
          setModels(r.models ?? [])
        } catch (error) {
          setNotice({ tone: 'error', text: error.message })
          setModels([])
        }
      }, [provider.id])


      if (notice && models === null) return h(Notice, { tone: notice.tone }, notice.text)


      if (models === null) return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取模型中…')
      if (models.length === 0) return h('div', { className: cx('empty') }, '该 provider 当前没有公开模型')

      /** 提交弹窗里勾选的模型：把它们追加到目标自定义模型的绑定链。 */
      const submitAddDialog = async () => {
        if (addDialog === null) return
        const target = customModels.find((x) => x.id === addDialog.target)
        if (target === undefined) return
        const picked = [...addDialog.picked]
        if (picked.length === 0) {
          setAddDialog(null)
          return
        }
        const existing = Array.isArray(target.bindings) ? target.bindings : []
        const merged = [...existing, ...picked.filter((p) => !existing.includes(p))]
        setBusy(true)
        setNotice(null)
        try {
          await rpc('customModels/update', { id: target.id, bindings: merged })
          const skipped = picked.length - (merged.length - existing.length)
          setNotice({
            tone: 'ok',
            text: `已加入「${target.name}」${merged.length - existing.length} 个模型` +
              (skipped > 0 ? `（${skipped} 个已存在，跳过）` : ''),
          })
          setCustomModels((prev) => prev.map((x) => (x.id === target.id ? { ...x, bindings: merged } : x)))
          setAddDialog(null)
        } catch (error) {
          setNotice({ tone: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        null,
        h('div', { className: cx('row'), style: { alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h(Notice, { tone: 'info', style: { flex: '1 1 320px' } }, `provider「${provider.name}」共 ${models.length} 个模型。模型公开名为 <模型>@${provider.slug}。`),
          h('button', {
            className: cx('btn'),
            disabled: busy,
            title: '重新读取该 provider 的模型清单。在 Hub 里新增或删除模型后点这里，无需关掉面板重开。',
            onClick: () => void reloadModels(),
          }, '刷新'),
          // ── 加入自定义模型 ──
          // 用按钮 + 弹窗而不是下拉：下拉一次只能加一个，面对 26 个模型要重复 26 次；
          // 弹窗里可以勾一批再确认，也能直接看到哪些已经在目标链里。
          customModels.length === 0
            ? null
            : h('button', {
                className: cx('btn'),
                type: 'button',
                disabled: busy,
                title: '批量勾选模型加入某个自定义模型的绑定链',
                onClick: () => setAddDialog({ target: customModels[0].id, picked: new Set() }),
              }, '＋ 加入自定义模型'),
        ),
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
                // ── 主标题：上游给的人话名 + 徽章 ──
                //
                // 只显示 publicName（如 qwenwork-intl/deepseek-flash@channel-hub）时，
                // 26 个模型里一半长得很像，用户根本分不清哪条是哪条。
                //
                // 上游的 LlmModelInfo.name 才是给人看的（「千问办公国际版 · DeepSeek-V4.1-Flash」），
                // badge 是上游挂的短标签（倍率「最低 x0.2」等）。
                // 所以：**人话名当主标题，徽章跟在后面，原始标识降级为副行。**
                h(
                  'span',
                  { className: cx('modelNameRow') },
                  // 人话名与标识重复时不单独显示主标题（否则上下两行一模一样）
                  nameIsSameAsId(m.name, m.model, m.publicName)
                    ? null
                    : h('span', { className: cx('modelName') }, m.name),
                  m.badge && m.badge.text
                    ? h(Pill, { tone: m.badge.tone === 'warn' ? 'warn' : 'neutral', title: '上游标注的短标签（通常是价格倍率）' }, m.badge.text)
                    : null,
                ),
                // ── 副行：原始标识（等宽、灰、可选中复制）──
                // 全名才是客户端要填的那个，必须保留，但不该当主标题抢占视觉。
                h('div', { className: cx('modelIdLine') },
                  h('code', { className: cx('mono', 'modelIdText'), title: '客户端调用时填这个名字' }, m.publicName),
                ),
                m.description ? h('div', { className: cx('modelDesc') }, m.description) : null,
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
                  h(Inline, { notice }),
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
        // ── 加入自定义模型弹窗 ──
        addDialog === null
          ? null
          : h(Modal, {
              title: '加入自定义模型',
              onClose: () => setAddDialog(null),
              children: h(
                'div',
                null,
                h('div', { className: cx('row'), style: { marginBottom: '10px' } },
                  h('label', { className: cx('muted'), style: { minWidth: '84px' } }, '目标模型'),
                  h('select', {
                    className: cx('select'),
                    value: addDialog.target,
                    onChange: (e) => setAddDialog((d) => ({ ...d, target: e.target.value })),
                  },
                    customModels.map((x) =>
                      h('option', { key: x.id, value: x.id },
                        `${x.display && x.display !== x.name ? x.display : x.name}（${(x.bindings ?? []).length} 个绑定）`),
                    ),
                  ),
                ),
                h('p', { className: cx('sectionHint') }, '勾选要加入的模型，已存在的会自动跳过。'),
                h(
                  'div',
                  { className: cx('addPickList') },
                  models.map((mm) => {
                    const targetModel = customModels.find((x) => x.id === addDialog.target)
                    const already = (targetModel?.bindings ?? []).includes(mm.publicName)
                    const checked = addDialog.picked.has(mm.publicName)
                    return h('label', {
                      key: mm.publicName,
                      className: cx('addPickRow', already ? 'addPickRowDone' : null),
                    },
                      h('input', {
                        type: 'checkbox',
                        className: cx('checkbox'),
                        checked: checked || already,
                        disabled: already,
                        onChange: () => {
                          setAddDialog((d) => {
                            const next = new Set(d.picked)
                            if (next.has(mm.publicName)) next.delete(mm.publicName)
                            else next.add(mm.publicName)
                            return { ...d, picked: next }
                          })
                        },
                      }),
                      h('span', { className: cx('addPickBody') },
                        h('span', { className: cx('addPickNameRow') },
                          h('span', { className: cx('addPickName') },
                            nameIsSameAsId(mm.name, mm.model, mm.publicName) ? mm.model : mm.name),
                          mm.badge && mm.badge.text
                            ? h(Pill, { tone: mm.badge.tone === 'warn' ? 'warn' : 'neutral' }, mm.badge.text)
                            : null,
                          already ? h(Pill, { tone: 'on' }, '已加入') : null,
                        ),
                        h('code', { className: cx('mono', 'addPickId') }, mm.publicName),
                      ),
                    )
                  }),
                ),
                h('div', { className: cx('row'), style: { marginTop: '12px', justifyContent: 'flex-end' } },
                  h('button', { className: cx('btn'), type: 'button', onClick: () => setAddDialog(null) }, '取消'),
                  h('button', {
                    className: cx('btn', 'btnPrimary'),
                    type: 'button',
                    disabled: busy || addDialog.picked.size === 0,
                    onClick: () => void submitAddDialog(),
                  }, `确认加入（${addDialog.picked.size}）`),
                ),
              ),
            }),
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
        let lastSig = ''
        const tick = async () => {
          try {
            const s = await rpcRef.current('status', {})
            if (cancelled) return
            // ⚠ status RPC 每次都会带一份实时 memory 分段（rss / heapUsed /
            // external…），这些数字每 5 秒几乎必然变化。而 LanternPage 只用
            // directory / enabled / listen 等结构性字段；子页（StatusPage 等）
            // 各自持有自己的状态，不读这里的 status。
            // 原来每次 tick 都 setStatus → 每 5 秒把整页连同所有 ModelPicker
            // 的候选分组全量重渲染一次。这里只在「除 memory 外」的签名变化时
            // 更新，memory 的显示由 StatusPage 自己的刷新路径负责。
            const { memory, ...structural } = s ?? {}
            void memory
            const sig = JSON.stringify(structural)
            if (sig !== lastSig) {
              lastSig = sig
              setStatus(s)
            }
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
     * 绑定行：序号 + 人话名 + 标识 + 徽章 + 上移/下移/删除。
     *
     * 顺序即故障转移优先级，所以"上移/下移"不是装饰——它就是功能本体。
     * 不做拖拽：设置窗口只有 ~340px 宽，拖拽在窄栏里极易误触。
     *
     * ## 为什么需要 info
     *
     * 只显示 `<model>@<provider>` 时，用户面对
     * 「deepseek-v4.1-flash@trae」「deepseek-v4.1-flash@buddy…」这类
     * 高度相似的标识，根本分不清哪条是哪条 —— 而这正是用户反馈的原话。
     *
     * `info` 是从候选列表里按 publicName 查出来的人话名与徽章：
     *   { name: '千问办公国际版 · DeepSeek-V4.1-Flash', badge: { text: '最低 x0.2' } }
     * 查不到（例如候选列表还没加载）时退回只显示标识，不会报错。
     */
    /**
     * 绑定行：序号 + 人话名 + 标识 + 徽章 + 拖拽手柄 + 上移/下移/删除。
     *
     * ## 拖拽
     *
     * 原生 HTML5 拖拽（draggable + dragstart/dragover/drop），不引第三方库。
     * 拖拽只改变**顺序**，顺序即故障转移优先级 —— 这是列表最核心的语义。
     *
     * 设置窗口只有 ~340px 宽，纯拖拽在小窗里容易误触，所以 ↑↓ 保留：
     * 微调用按钮，大跨度的移动用拖拽。
     */
    function BindingRow(props) {
      const { binding, index, status, info, drag, modelId, onDragStart, onDragOver, onDragCancel, onDrop, onRemove } = props
      // status 可能来自 statusMap.get(b) —— Map 没命中时是 undefined，
      // 也可能是外部显式传的 null。两者都必须当"没有状态"处理，
      // 否则 `null.available` 会抛 TypeError 让整个面板白屏。
      const ok = status === undefined || status === null ? null : status.available
      const showName = info !== undefined && info !== null
        && !nameIsSameAsId(info.name, info.model, binding)
      // ⚠ drag 的初值是 null（不是 undefined），所以必须显式判 null ——
      // 只写 `drag !== undefined` 会让 null 通过，接着 `drag.from` 抛
      //   TypeError: Cannot read properties of null (reading 'from')
      // 整个面板白屏。这里用 `drag !== null && drag !== undefined` 双保险。
      const hasDrag = drag !== null && drag !== undefined
      // ⚠ drag 是页面级单份 state，不比对 modelId 的话：
      //   · 拖 A 的第 2 行，会让所有模型的第 2 行一起变半透明
      //   · 跨模型 drop 会拿 A 的下标去 splice B 的绑定并落盘（A 反而不变）
      const sameModel = hasDrag && drag.modelId === modelId
      const isDragging = sameModel && drag.from === index
      const isDropTarget = sameModel && drag.over === index && drag.from !== index
      return h(
        'div',
        {
          className: cx('bindRow', isDragging ? 'bindRowDragging' : null, isDropTarget ? 'bindRowDropTarget' : null),
          draggable: true,
          onDragStart: (e) => {
            // setData 是必须的：Firefox 不设就不触发 drop
            // 带上 modelId：drop 时用它挡住跨模型误操作。
            e.dataTransfer.setData('text/plain', String(modelId) + ':' + String(index))
            e.dataTransfer.effectAllowed = 'move'
            onDragStart(index)
          },
          onDragOver: (e) => {
            e.preventDefault()   // 不 preventDefault 就不会触发 drop
            e.dataTransfer.dropEffect = 'move'
            onDragOver(index)
          },
          onDrop: (e) => {
            e.preventDefault()
            // ⚠ from 必须从 dataTransfer 读，不能用闭包里的 drag.from。
            //
            // 原因：dragover 会持续触发 setDrag(...)，React 的重渲染可能在
            // drop 事件派发前完成，也可能没完成 —— 闭包里的 drag 是**渲染那一刻**
            // 的快照，不保证是最新的。一旦拿到 null 或旧值，dropAt 就提前 return，
            // 表现就是"拖了没反应"。
            //
            // dataTransfer 是拖拽事件自带的、在整次拖拽里唯一不变的可信来源。
            const raw = e.dataTransfer.getData('text/plain')
            const sep = typeof raw === 'string' ? raw.lastIndexOf(':') : -1
            const srcModel = sep > 0 ? raw.slice(0, sep) : ''
            const from = sep > 0 ? Number(raw.slice(sep + 1)) : null
            // 跨模型拖拽没有语义（用 A 的下标改 B 的顺序），直接忽略。
            if (srcModel !== String(modelId)) return
            onDrop(index, Number.isInteger(from) ? from : null)
          },
          // 拖出列表外 / 按 Esc 取消时必须彻底清空 drag。
          // 原来写 onDragOver(null) 只把 over 置 null，drag.from 仍在，
          // 源行会永久挂着半透明样式，直到下一次成功 drop。
          onDragEnd: () => onDragCancel(),
        },
        h('span', { className: cx('bindHandle'), title: '拖拽调整优先级' }),
        h('span', { className: cx('bindOrder') }, String(index + 1)),
        h(
          'span',
          { className: cx('bindName'), title: binding },
          // 第一层：人话名 + 徽章（人话名与标识重复时整层省略）
          showName
            ? h('span', { className: cx('bindNameMain') },
                h('span', { className: cx('bindTitle') }, info.name),
                info.badge && info.badge.text
                  ? h(Pill, { tone: info.badge.tone === 'warn' ? 'warn' : 'neutral' }, info.badge.text)
                  : null,
              )
            : null,
          // 第二层：标识 + 可用状态（标识总是显示，它是客户端要填的那个）
          h('span', { className: cx('bindMeta') },
            h('code', { className: cx('mono', showName ? 'bindIdSub' : null) }, binding),
            ok === null
              ? null
              : h(Pill, { tone: ok ? 'on' : 'warn' }, ok ? '可用' : status?.reason ? '失效' : '未知'),
            // ── 失效项的移除按钮（关键）──
            //
            // 失效的绑定**不在候选下拉里**（它对应的真实模型已从 provider 消失），
            // 于是用户没法用"再点一次"的方式移除它 —— 那条绑定就成了删不掉的死数据。
            //
            // 所以这里给它一个独立的 ✕。只在失效时出现：
            // 健康的项仍然通过下拉切换，不需要额外按钮占位。
            ok === false && onRemove !== undefined
              ? h('button', {
                  className: cx('iconBtn', 'iconBtnDanger', 'bindRemoveBtn'),
                  type: 'button',
                  title: '移除这条失效的绑定',
                  onClick: (e) => {
                    e.stopPropagation()
                    onRemove(index)
                  },
                }, '✕')
              : null,
          ),
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
      // 编辑中的绑定（按 id 存，切换展开时丢弃未保存改动）
      const [editBindings, setEditBindings] = React.useState([])
      // 拖拽状态：{ from, over } —— from 是拖起的行，over 是当前悬停的目标行。
      // 用 state 而不是 ref，因为要实时高亮"会被插到哪"。
      const [drag, setDrag] = React.useState(null)
      // 编辑中的调优参数（后端首包超时 / 整个请求的重试预算）。
      // 用字符串存：输入过程中会出现 "" 这类中间态，立刻 Number() 会把光标吃掉，
      // 保存时才收敛成数字（服务端还有一层 normalize 兜底）。
      const [editTimeoutMs, setEditTimeoutMs] = React.useState('')
      // 编辑中的模型名（客户端在 model 字段里填的那个名字）。
      //
      // 改名会让旧名字立刻失效，所以它和绑定链是分开保存的 —— 绑定改动即时落盘，
      // 改名要单独确认一次。
      const [editName, setEditName] = React.useState('')
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

      // ══════════ 自动保存（必须在任何 early return 之前） ══════════
      //
      // React 要求每次渲染的 hook 数量与顺序完全一致：一旦 useRef/useEffect
      // 出现在 early return 之后，首帧不执行、第二帧执行，就会报
      //   "Rendered more hooks than during the previous render"
      // 整个页面白屏。所以这两个 ref 一律放在最前面。

      /** 保存序号（按 modelId 分开）：后发先至时，旧请求的结果不允许覆盖 UI。 */
      const saveSeqRef = React.useRef(new Map())
      /** reload 合并定时器：连点多个模型只刷新一次列表。 */
      const reloadTimerRef = React.useRef(null)
      /** 调优参数（文本输入）的防抖定时器。 */
      const tuningTimerRef = React.useRef(null)

      /**
       * 自动保存：把「改了就该生效」的字段写回服务端。
       *
       * 绑定 / 超时 / 重试 / 档位都属于这一类 —— 用户的期待是"改完就生效"，
       * 多按一次确认没有收益，反而容易忘。
       *
       * 不监听 state 变化（那样打开编辑面板回填时也会写一次盘），
       * 由操作方显式调用：只有真正的用户动作才保存。
       *
       * 并发：连点会发多次请求，用 seq 保证只有最新一次的结果覆盖 UI；
       * reload 延后 300ms 合并，避免一个动作打一次全量请求。
       *
       * @param modelId - 目标自定义模型 id
       * @param patch - 要更新的字段（通常是 { bindings } 或调优参数）
       */
      const autoSave = (modelId, patch) => {
        // ⚠ 乐观更新：立刻把本次 bindings 快照写回本地 models。
        //
        // 收起态的所有操作（加入 / 移除 / 批量 / 拖拽 / 删除）都从 m.bindings
        // 起算，而 m 只在 300ms 防抖 reload 之后才刷新。用户被明确允许
        // 「连点、下拉不关闭」，于是 300ms 内的第二次操作仍基于旧数组，
        // 算出的全量快照会把第一次的改动覆盖掉（连点 c、d → 只剩 d）。
        // 同一原因还让 ✓「已启用」要等 reload 才出现，看着像"点了没反应"。
        //
        // 这里同步更新 models，让下一次点击立刻看到新基准；300ms 后的
        // reload 只是用服务端结果再确认一次，不再承担 UI 反馈的职责。
        if (Array.isArray(patch.bindings)) {
          const snapshot = patch.bindings.slice()
          setModels((prev) => (prev === null
            ? prev
            : prev.map((m) => (m.id === modelId ? { ...m, bindings: snapshot } : m))))
        }
        const seqMap = saveSeqRef.current
        const seq = (seqMap.get(modelId) ?? 0) + 1
        seqMap.set(modelId, seq)
        void (async () => {
          try {
            await rpcRef.current('customModels/update', { id: modelId, ...patch })
            if (seqMap.get(modelId) !== seq) return
            if (reloadTimerRef.current !== null) clearTimeout(reloadTimerRef.current)
            reloadTimerRef.current = setTimeout(() => {
              reloadTimerRef.current = null
              void reload()
            }, 300)
          } catch (error) {
            if (seqMap.get(modelId) === seq) {
              // 保存失败：撤回乐观值，否则界面会一直显示一个没落盘的状态
              void reload()
              setNotice({ tone: 'error', text: `自动保存失败：${error.message}` })
            }
          }
        })()
      }

      /**
       * 调优参数的防抖自动保存。
       *
       * 这几个是文本输入（"3000" → "" → "30000"），每按一键发请求既浪费
       * 也会让输入框抖动。停顿 600ms 后发一次。
       */
      /** 尚未落盘的调优参数（超时等），供切模型时 flush。 */
      const pendingTuningRef = React.useRef(null)
      const scheduleTuningSave = (modelId, patch) => {
        pendingTuningRef.current = { modelId, patch }
        if (tuningTimerRef.current !== null) clearTimeout(tuningTimerRef.current)
        tuningTimerRef.current = setTimeout(() => {
          tuningTimerRef.current = null
          const pending = pendingTuningRef.current
          pendingTuningRef.current = null
          if (pending !== null) autoSave(pending.modelId, pending.patch)
        }, 600)
      }
      /**
       * 立刻把待提交的调优参数落盘。
       *
       * ⚠ 切模型/收起时**不能**只 clearTimeout：那样 600ms 内改的超时值会被
       * 静默丢弃（这个字段已经没有「保存」按钮，防抖是唯一写入路径），
       * 下次展开又从服务端旧值回填，用户会以为改了但没生效。
       */
      const flushTuningSave = () => {
        if (tuningTimerRef.current === null) return
        clearTimeout(tuningTimerRef.current)
        tuningTimerRef.current = null
        const pending = pendingTuningRef.current
        pendingTuningRef.current = null
        if (pending !== null) autoSave(pending.modelId, pending.patch)
      }

      // 卸载时清掉未触发的定时器：否则会把值写到别的模型上，
      // 或在已卸载组件上 setState。
      React.useEffect(() => () => {
        if (tuningTimerRef.current !== null) clearTimeout(tuningTimerRef.current)
        pendingTuningRef.current = null
        if (reloadTimerRef.current !== null) clearTimeout(reloadTimerRef.current)
      }, [])

      if (models === null) return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取自定义模型中…')

      /**
       * 把 from 行移动到 to 位置并落盘。
       *
       * 语义是「插到 to 之前」（不是交换）。base 非空表示面板**收起**，
       * 此时 editBindings 还是空的（只在点「编辑」时填充），必须用已落盘的
       * m.bindings 做基准，否则 from 会撞上越界检查直接 return，表现就是"拖了没反应"。
       *
       * 原先这里还有 move / toggleBinding / bulkSet 三个函数，但 ↑↓ 按钮移除后
       * 全部没有调用点，已删除 —— 留着只会让人误以为有别的写入路径。
       */
      const dropAt = (modelId, from, to, base) => {
        setDrag(null)
        if (from === to || from === null || to === null) return
        if (from === undefined || to === undefined) return
        const finish = (list) => {
          autoSave(modelId, { bindings: list })
          return list
        }
        /**
         * 把 from 位置的元素移到 to 位置。
         *
         * ## 插入下标**不能**做 "from < to ? to - 1 : to" 的修正
         *
         * 这是最容易写错的一处。语义是"**放到 to 这个下标上**"，摘出元素后
         * 直接 `splice(to, 0, item)` 即可：
         *
         * ```
         * [a,b,c]  from=0  to=1
         *   摘出 a → [b,c]
         *   splice(1,0,'a') → [b,a,c]     ← a 到了原 b 的位置
         *
         * 若错误地减一：splice(0,0,'a') → [a,b,c]   ← 插回原位，等于没动
         * ```
         *
         * 减一版本恰恰会让 **相邻两行的拖动完全失效**（from=0,to=1 是最常见
         * 的"往下挪一格"），表现得就像拖拽根本不能用。
         */
        const moveWithin = (src) => {
          const list = src.slice()
          if (from < 0 || from >= list.length || to < 0 || to >= list.length) return null
          if (from === to) return null
          const [item] = list.splice(from, 1)
          list.splice(to, 0, item)
          return list
        }

        if (base !== undefined) {
          // 收起态：基于传入的冻结列表算，不碰 editBindings
          const out = moveWithin(base)
          if (out === null) return
          finish(out)
          return
        }
        // ⚠ 副作用（发 RPC / setNotice）不能放在 setState 的 updater 里：
        // React StrictMode 下 updater 可能被调用两次 → 重复保存。
        // 拖拽是低频单次操作，用当前渲染的 editBindings 算即可。
        const out = moveWithin(editBindings ?? [])
        if (out === null) return
        setEditBindings(out)
        finish(out)
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
      // ── 绑定候选：按 provider 分组后的**扁平列表**（不是 <option> 节点）──
      //
      // 原生 <select> 的 <option> 只能放纯文本，**没法做两行 + 徽章**。
      // 而用户的实际困惑正是：「列表里全是 qwenwork/deepseek-flash 这种标识，
      // 分不清哪条是哪条」。
      //
      // 所以改成自定义下拉：每个候选项是一块可点区域，布局为
      //   第一行：人话名 + 徽章（倍率等）
      //   第二行：原始标识（灰字等宽）
      // 已绑定过的项打绿色勾 + 「已启用」徽章。
      //
      // 分组仍然保留（provider 大类），因为候选是全局铺平的。
      const bindingGroups = candidates.length === 0
        ? []
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
            for (const g of ordered) {
              g.items.sort((a, b) => {
                // 人话名优先排序（没有就退回标识），与用户看列表的顺序一致
                const an = a.name || a.model || a.publicName
                const bn = b.name || b.model || b.publicName
                return an.localeCompare(bn)
              })
            }
            return ordered
          })()

      // 当前已绑定的集合（用于打「已启用」标记）
      const boundSet = new Set((editBindings ?? []).map((b) => String(b)))

      return h(
        'div',
        null,
        h(Notice, { tone: 'info' },
          '自定义模型是一个虚拟模型名：客户端填这个名字发请求，网关按下面的绑定顺序逐个尝试，' +
          '第一个出字的后端就赢。顺序即优先级，拖动绑定行即可调整。'),

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
            '字母/数字/下划线/点/连字符/斜杠，不能带 @。'),
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
                // display 已合并进 name：不再单独收集，直接回落到 name
                await rpcRef.current('customModels/create', {
                  name: draftName.trim(),
                  bindings: [],
                })
                setDraftName('')
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
              // publicName → 候选信息（人话名 / 徽章）。
              // 绑定行只存 <model>@<provider> 标识；要显示人话名与徽章，
              // 必须回候选列表里查 —— 候选是同一个 RPC 拿到的，不会有额外请求。
              const infoMap = new Map((candidates ?? []).map((c) => [c.publicName, c]))
              // 旧数据 / 迁移异常时 bindings 可能缺失；渲染路径上直接 .length / .map
              // 会抛 TypeError → 整个自定义模型页白屏。统一在这里兜底。
              const savedBindings = Array.isArray(m.bindings) ? m.bindings : []
              const list = open ? (editBindings ?? []) : savedBindings
              return h(
                'div',
                { key: m.id, className: cx('section') },
                h(
                  'h3',
                  { className: cx('sectionTitle') },
                  h('span', { className: cx('mono') }, m.name),
                  h('span', { className: cx('row') },
                    m.enabled ? h(Pill, { tone: 'on' }, '启用中') : h(Pill, { tone: 'off' }, '已停用'),
                    h('span', { className: cx('muted') }, `${savedBindings.length} 个绑定`),
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
                          status: statusMap.get(b),
                          info: infoMap.get(b),
                          drag,
                          modelId: m.id,
                          onDragStart: (idx) => setDrag({ modelId: m.id, from: idx, over: idx }),
                          // dragover 每几毫秒触发一次；无变化时不产生新对象，
                          // 否则整页（含所有 ModelPicker）会被高频重渲染。
                          onDragOver: (idx) => setDrag((d) => (d === null || d.over === idx ? d : { ...d, over: idx })),
                          onDragCancel: () => setDrag(null),
                          onDrop: (idx, fromIdx) => dropAt(
                            m.id,
                            fromIdx,
                            idx,
                            open ? undefined : (Array.isArray(m.bindings) ? m.bindings : []),
                          ),
                          // ⚠ 删除必须**收起态也能用**。
                          //
                          // 绑定列表是常驻显示的（不点「编辑」就能看到），
                          // 其中可能有失效项 —— 而那些失效项的唯一移除方式就是这个按钮
                          //（它们不在候选下拉里）。若这里写成 `open ? ... : () => {}`，
                          // 收起时点 ✕ 会进空函数，表现为"点了没反应"。
                          //
                          // 收起态从 m.bindings（已落盘的真实绑定）起算，
                          // 展开态才用 editBindings —— 与拖拽、下拉保持一致。
                          onRemove: (idx) => {
                            const base = open
                              ? (editBindings ?? [])
                              : (Array.isArray(m.bindings) ? m.bindings : [])
                            const next = base.filter((_, k) => k !== idx)
                            if (open) setEditBindings(next)
                            autoSave(m.id, { bindings: next })
                          },
                        }),
                      ),
                    ),

                // ── 常驻绑定选择器 ──
                //
                // 放在绑定列表正下方而不是「编辑」面板里：自动保存之后已经没有
                // "未保存"的概念，看到列表就能直接往这条链上加/减。
                //
                // 收起时用已落盘的 m.bindings，展开时用编辑中的 editBindings ——
                // 否则收起状态下点一下会从一个空数组开始，把已有绑定全冲掉。
                h('div', { className: cx('bindPickerWrap') },
                  h(ModelPicker, {
                    groups: bindingGroups,
                    bound: open ? boundSet : new Set(m.bindings ?? []),
                    disabled: busy,
                    emptyText: candidates.length === 0 ? '没有可绑定的模型' : '点击添加 / 再次点击移除…',
                    // 收起状态下**只改绑定，不动编辑面板**。
                    //
                    // 之前这里会 setOpenId 把编辑区拉开 —— 用户只想加个模型，
                    // 结果下面突然展开一整块表单，很不舒服。现在收起态直接
                    // 基于 m.bindings 算出新数组发给服务端，面板保持闭合。
                    onChange: (publicName) => {
                      const current = open ? (editBindings ?? []) : (Array.isArray(m.bindings) ? m.bindings : [])
                      const next = current.includes(publicName)
                        ? current.filter((x) => x !== publicName)
                        : [...current, publicName]
                      if (open) setEditBindings(next)
                      autoSave(m.id, { bindings: next })
                    },
                    onBulkAdd: (names, clear) => {
                      const current = open ? (editBindings ?? []) : (Array.isArray(m.bindings) ? m.bindings : [])
                      const next = clear === true
                        ? []
                        : [...current, ...names.filter((n) => !current.includes(n))]
                      if (open) setEditBindings(next)
                      autoSave(m.id, { bindings: next })
                    },
                  }),
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
                      ),
                      h('p', { className: cx('sectionHint') },
                        '客户端在 model 字段填的名字。改名后旧名字立刻失效，客户端要同步改。'),
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
                            onChange: (e) => {
                              setEditTimeoutMs(e.target.value)
                              scheduleTuningSave(m.id, { timeoutMs: Number(e.target.value) })
                            },
                          }),
                        ),
                        h('p', { className: cx('muted'), style: { marginTop: '6px' } },
                          '首字超过这个时间就切到下一个后端；0 = 不限时。'),
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
                            // 显示名已合并进模型名：原来两个字段默认同值，
                            // 属于重复信息。现在列表和下拉都只显示模型名。
                            const displayPatch = namePatch.name !== undefined ? namePatch.name : m.name
                            void run(async () => {
                              // 只发「名字」相关字段：绑定 / 超时 / 重试 / 档位
                              // 都由 autoSave 在用户操作时即时落盘，这里再发一遍
                              // 会用旧的 editBindings 覆盖掉刚自动保存的结果。
                              await rpcRef.current('customModels/update', {
                                id: m.id,
                                ...namePatch,
                                display: displayPatch,
                              })
                              // 同步编辑区自己的值：`run()` 里的 reload 只刷新列表，
                              // editName 是独立 state，不跟着变 —— 不同步的话用户会
                              // 盯着旧名字以为"没保存成功"。
                              setEditName(namePatch.name ?? m.name)
                            }, namePatch.name === undefined ? '已保存' : '已改名（客户端记得同步改 model 字段）')
                          },
                        }, '更新名字'),
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
                          disabled: busy || savedBindings.length === 0,
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
                                { key: r.binding, className: cx('bindRow', 'bindRowTest') },
                                h('span', { className: cx('bindOrder') }, r.ok ? '✓' : '✕'),
                                // ⚠ 这里**不能**复用 bindName：它是纵向两层的容器
                                // （模型名 + 标识），会给这行带来 flex-direction: column，
                                // 结果把右侧的 "1817 ms" 挤到第二行。
                                // 测速行是单行的，用独立的 bindTestName。
                                h('span', {
                                  className: cx('bindTestName'),
                                  title: r.binding,
                                }, h('code', { className: cx('mono') }, r.binding)),
                                h('span', {
                                  className: r.ok ? cx('green', 'bindTestMs') : cx('red', 'bindTestMs'),
                                  // 结果文本可能很长（错误原因），允许省略而不是撑破布局
                                  title: r.ok ? `${r.latencyMs} ms` : (r.reason ?? r.raw ?? r.code ?? '失败'),
                                },
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
                      // 切换/收起前把未落盘的调优参数**立即提交**。
                      // 原先只 clearTimeout：600ms 内改的超时值会被静默丢弃，
                      // 而这个字段没有「保存」按钮，防抖是唯一写入路径。
                      // patch 里已绑定 modelId，不会写到别的模型上。
                      flushTuningSave()
                      if (open) {
                        setOpenId(null)
                      } else {
                        setOpenId(m.id)
                        setEditBindings(Array.isArray(m.bindings) ? m.bindings.slice() : [])
                        setEditTimeoutMs(String(m.timeoutMs ?? 30000))
                        setEditName(m.name)
                        setTested(null)
                        setNotice(null)
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
