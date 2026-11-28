# 回归测试套件

一套持续扩充的离线回归，覆盖插件最容易出错的地方：模块完整性、消息构造形状、面板字段对齐、能力闸门、推理契约、故障转移顺序、账本聚合……当前套数与检查项数量请以运行 `node tests/.regress.mjs` 的输出为准，本文不写死数字。

**绝大多数是静态/单元级检查，不访问上游、不花钱、不需要网关运行；少数在线用例在没有 `LANTERN_TEST_KEY` 时会自动跳过。**

## 怎么跑

```bash
# 在插件根目录（含 lib/ 的那一层）
node tests/.regress.mjs
```

输出（末尾会打印套数、检查项总数与失败数，具体数字以本次运行为准）：

```
==== <套数> 套 / <检查项> 项 / <失败数> 失败 ====
```

**如果你的 tests/ 不在插件目录里**（比如单独拷出来），用环境变量指定：

```bash
LANTERN_DIR=/path/to/dsh-lantern node .regress.mjs
```

路径解析见 `paths.mjs`，优先级：`LANTERN_DIR` → `tests/` 的上一级 → 当前工作目录。

## 单跑某一个

```bash
node tests/test-module-integrity.mjs
node tests/test-panel-integrity.mjs
node tests/test-message-shape.mjs
```

每个文件独立输出 `N passed / M failed`，失败时退出码为 1。

## 需要网关运行的测试

少数几个（`test-qwen-real.mjs` 等）会真的发请求，需要：

1. 网关正在运行
2. 设 `LANTERN_TEST_KEY` 为有效的 API Key

```bash
LANTERN_TEST_KEY=sk-xxx node tests/test-qwen-real.mjs
```

不设的话这些用例**仍会被 `.regress.mjs` 计入套数**，但会自动跳过（不会因缺 Key 而失败）；只有设了有效 Key 且网关在运行时才会真正发请求。

## 三个"守卫测试"值得单独说

它们是"测试全绿但插件坏着"这类盲区的防线：

| 测试 | 守什么 | 事故来源 |
|---|---|---|
| `test-module-integrity.mjs` | 插件能被平台正确加载（`inject` / `apply` / 导出） | 删死代码时误删 `var inject` → 插件起不来 |
| `test-panel-integrity.mjs` | 面板 state 的作用域、`usage.*` 字段与 RPC 对齐 | 批量替换误改 11 处依赖数组 → 面板空白 |
| `test-message-shape.mjs` | DSH 消息构造的参数形状（system 单参数、user 对象+数组） | 传了不存在的 provider id → `content.some is not a function` |

## 已剔除的文件

原来的调试脚本（`chk2.mjs` / `cat.mjs` / `smoke-roll.mjs` / `simulate-failover-order.mjs`）
以及含真实 API Key 的 `testkey.txt` 没有包含在本套件里。

## 说明

这些测试最初写于本机开发过程中，路径曾是绝对路径。现在统一从 `paths.mjs` 解析，
并且因为 `tests/` 就在插件目录下，`import '../lib/...'` 永远可用。