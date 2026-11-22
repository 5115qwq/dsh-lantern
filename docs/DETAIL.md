# LANtern · 局域网模型网关

把本机 **DeepSeek Harness** 已注册的全部模型，以 **OpenAI / Anthropic 兼容接口**开放给同一局域网。

插件不复制、不代理、不落盘任何上游凭证 —— 只读取 DSH 的模型目录，通过 DSH 自身通道发起请求。

> 本插件是 [Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern) 的改版（MIT），
> 感谢原作者的基础实现。

## 功能

**三种协议，同一套内核**

- OpenAI Chat Completions（`/v1/chat/completions`）
- Anthropic Messages（`/v1/messages`）
- OpenAI Responses（`/v1/responses`）

流式与非流式共享同一套故障转移与降级判据。

**四档推理契约**

对外只暴露 `minimal` / `low` / `medium` / `max`，内部按每个模型真实的词表换算。
客户端无需了解各上游的词表差异。`/v1/models` 的 `contractLevels` 会列出每档实际下发的词。

**能力闸门**

参数支持分「支持 / 不支持 / 未知」三态。`未知` 照常下发 —— 不会因为没见过就把参数剥掉。
确有剥离时，通过响应头明确告知，不静默丢弃。

**故障转移与健康冷却**

一个对外模型可绑定多个上游，失败自动切换。
失败上游进入指数退避冷却，冷却期内直接跳过。
全部冷却时立即返回 503，同时后台自检，恢复即刻可用。

**API Key**

每个 Key 独立限流限额，可停用而不影响客户端配置。
生成即永久有效，明文可随时查看。

**用量统计**

按模型 / Key / 上游 / 类型 / 时间多维统计。
HTML 报告（自包含单文件）+ CSV 全量导出 + PNG 图表导出。

## 用法

安装后在 **设置 → LANtern** 打开面板：

1. **监听与端口** —— 选择 `reuse`（复用 DSH 端口）或 `standalone`（独立端口）
2. **API Key 管理** —— 生成一个 Key，复制其明文
3. **自定义模型**（可选）—— 把多个上游绑定成一个对外名称

客户端配置：

```bash
curl http://<本机IP>:<端口>/v1/chat/completions \
  -H "Authorization: Bearer sk-你的明文" \
  -H "Content-Type: application/json" \
  -d '{"model":"你的模型名","messages":[{"role":"user","content":"你好"}],"max_tokens":500}'
```

## 重要限制

- **`reuse` 模式的绑定地址由 DSH 启动参数 `--host` 决定**，插件无权更改。面板显示的是实际绑定地址。
- **超时为「首字节超时」**：长思考模型思考数十秒后才输出正文属正常，不会被误判超时。
- **`max_tokens` 最终由上游决定**：插件原样透传，仅在超过配置上限时收缩。实际值见 `X-Lantern-Max-Tokens`。
- **`data/keys.json` 保存 API Key 明文**：为便于随时查看，而非"忘记只能重新生成"。请勿提交到版本库。
- **附件账本仅追踪本插件创建的附件**，不影响 DSH 自身。

## 安全

开放到局域网意味着同网段任何客户端都可能访问：

- 务必设置 API Key，不要启用匿名访问（除非完全信任所在网络）
- 不要将 `0.0.0.0` 暴露到公共网络
- 定期查看用量统计，异常调用量是异常访问的第一信号
- 保持 `exposure.maskTopology` 开启，分享截图时不会泄露上游拓扑

## 更多文档

- 完整功能说明、配置项全表、诊断响应头、错误码：仓库 `README.md`
- 详细操作指南与排障：仓库 `LANtern-完整手册.md`

## 致谢

原版：[Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern) by [@Saretheya](https://github.com/Saretheya)（MIT）