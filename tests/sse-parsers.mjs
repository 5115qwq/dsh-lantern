// 三协议各自的 SSE 解析器 —— 结构完全不同，不能共用。
//
// chat/completions:  choices[0].delta.{content, reasoning_content, tool_calls}
// anthropic/messages:  type=content_block_delta, delta.{type:'text_delta'|'thinking_delta', text|thinking}
// responses:          type=response.output_text.delta / response.reasoning_summary_text.delta
export function makeParser(kind) {
  const state = {
    reason: '',
    content: '',
    toolDeltas: 0,
    sawDone: false,
    events: [],
    deltas: [],
  }

  const onData = (payload) => {
    if (payload === '[DONE]') { state.sawDone = true; return }
    let j
    try { j = JSON.parse(payload) } catch { return }
    state.events.push(j?.type ?? 'chunk')

    if (kind === 'chat') {
      const d = j?.choices?.[0]?.delta ?? {}
      if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) {
        state.reason += d.reasoning_content
      }
      if (typeof d.content === 'string' && d.content.length > 0) {
        state.content += d.content
        state.deltas.push(d.content)
      }
      if (Array.isArray(d.tool_calls)) state.toolDeltas += d.tool_calls.length
      return
    }

    if (kind === 'anthropic') {
      // event: content_block_start
      // data: {type:'content_block_start', index, content_block:{type:'text'|'thinking'|'tool_use', text?/thinking?/name?}}
      //   ⚠ 这里可能**直接带初始文本**，漏了就会少字（实测 glm 的正文一部分在这里）
      // event: content_block_delta
      // data: {type:'content_block_delta', index, delta:{type:'text_delta'|'thinking_delta'|'input_json_delta', ...}}
      // event: message_stop
      if (j?.type === 'content_block_start') {
        const cb = j?.content_block ?? {}
        if (cb.type === 'text' && typeof cb.text === 'string' && cb.text.length > 0) {
          state.content += cb.text
          state.deltas.push(cb.text)
        } else if (cb.type === 'thinking' && typeof cb.thinking === 'string' && cb.thinking.length > 0) {
          state.reason += cb.thinking
        } else if (cb.type === 'tool_use') {
          state.toolDeltas += 1
        }
      } else if (j?.type === 'content_block_delta') {
        const d = j?.delta ?? {}
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          state.content += d.text
          state.deltas.push(d.text)
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          state.reason += d.thinking
        } else if (d.type === 'input_json_delta') {
          state.toolDeltas += 1
        }
      } else if (j?.type === 'message_stop') {
        state.sawDone = true
      }
      return
    }

    if (kind === 'responses') {
      const t = j?.type
      if (t === 'response.output_text.delta' && typeof j.delta === 'string') {
        state.content += j.delta
        state.deltas.push(j.delta)
      } else if (t === 'response.reasoning_summary_text.delta' && typeof j.delta === 'string') {
        state.reason += j.delta
      } else if (t === 'response.function_call_arguments.delta') {
        state.toolDeltas += 1
      } else if (t === 'response.completed') {
        state.sawDone = true
      } else if (t === 'response.output_item.added' && j?.item?.type === 'function_call') {
        state.toolDeltas += 1
      }
    }
  }

  return { onData, state }
}

/** 逐行喂 SSE 文本，返回解析后的状态。 */
export function parseSseText(text, kind) {
  const p = makeParser(kind)
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    p.onData(line.slice(5).trim())
  }
  return p.state
}
