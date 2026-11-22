# 发布流程

> 本文件是**发布纪律**。改动发布流程前先读这里。

---

## 铁律：Release 只增不删

**已经发布的 Release 与 tag 永远保留，不删除、不覆盖。**

### 为什么

- **回滚能力**：用户装到某版出问题时，必须能装回上一版；
- **版本历史**：Release 页面是项目的版本履历，删掉就断了；
- **可追溯**：每个 zip 对应一个 commit，删掉就失去"当时的安装包是什么"的证据。

### 反面案例（真实发生过）

早期为了"保持整洁"，每次发布都删掉旧 Release，只留最新一个。
结果一次数据丢失事故后想回滚到上一版，**发现旧版本的 zip 已经没了** ——
只能从 git 历史重建（还踩了中文文件名的坑，见下）。

**现在每次发布只新增 Release，旧的保持原样。**

---

## 发布步骤

### 1. 升版本

`package.json` 的 `version` 按语义化版本递增：

| 变更类型 | 版本 | 例 |
|---|---|---|
| 破坏性变更 / 数据位置变更 | minor（甚至 major） | `1.0.5 → 1.1.0` |
| 新功能 | minor | `1.0.5 → 1.1.0` |
| 修 bug | patch | `1.0.5 → 1.0.6` |

### 2. 跑回归

```bash
node tests/.regress.mjs
```

必须 `0 失败` 才能发。CI 也会再跑一遍（Node 22/24 Ubuntu + Node 22 Windows）。

### 3. 提交并推送

```bash
git add -A
git commit -F <message-file>   # 用文件传 message，避免 shell 引号吃掉中文引号
git push origin main
```

> ⚠ **commit message 用文件传**：直接 `-m "..."` 时，中文引号（`"` `"`）
> 会被 PowerShell 当成分隔符，导致 message 被截断、commit 失败。

### 4. 打 zip

**必须用 `git checkout <sha>` 的工作区内容，不要用 `git archive` + `tar`。**

```bash
git clone https://github.com/5115qwq/dsh-lantern tmp-clone
cd tmp-clone
git checkout -f <完整 SHA>
git clean -fdx
```

然后用 **Node 的 `copyFileSync`** 复制（不要用 PowerShell 的 `Copy-Item`）。

**为什么**：

| 方法 | 中文文件名 | 结果 |
|---|---|---|
| `git archive` + `tar -xf` | ❌ tar 解压时编码丢失 → 文件变乱码名 | 手册丢失 |
| PowerShell `Copy-Item` 从 tar 解出的目录 | ❌ 源名已是乱码 | 手册丢失 |
| **`git checkout` 的工作区 + Node `copyFileSync`** | ✅ UTF-8 路径正确处理 | 正确 |

**真实事故**：重建 v1.0.2/1.0.3/1.0.4 时用 `git archive` + `tar`，
`LANtern-完整手册.md` 被解成乱码名，zip 少了 42 KB（手册的压缩体积）。
改用 `git checkout` 后才修复。

### 5. zip 必须包含的顶层项

```
lib/                  ← 必需（代码）
locale/               ← 必需（显示名/描述）
docs/                 ← 必需（详情页文档与特性图）
icon.svg              ← 必需（图标）
package.json          ← 必需
cordis.patch.yml      ← 必需（bundle 装配层）
README.md             ← 文档
README.en.md          ← 文档
LICENSE               ← 许可
LANtern-完整手册.md   ← 操作手册（易漏，必须核对）
```

**不含**：`tests/`、`.github/`、`data/`、`.gitattributes`、`.gitignore`。

### 6. 建 Release 并上传

```js
POST /repos/{owner}/{repo}/releases
{
  tag_name: 'vX.Y.Z',
  target_commitish: '<完整 40 位 SHA>',   // ⚠ 不能用短 SHA，GitHub 会报 422
  name: 'LANtern X.Y.Z',
  body: '<中文说明>',
  draft: false,
  prerelease: false
}
```

```js
POST https://uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name=dsh-lantern-vX.Y.Z.zip
Content-Type: application/zip
```

> ⚠ `target_commitish` **必须是完整 SHA** 或分支名。
> 传短 SHA（7 位）会返回 `422 tag_name is not a valid tag`，
> 错误信息会误导你以为 tag 名有问题。

### 7. 发布后核对

```
□ Release 列表里所有历史版本都还在（只增不删）
□ 新版本的 zip 可匿名下载
□ zip 里的 package.json version == tag
□ zip 含全部 10 个顶层项（尤其手册）
□ zip 无 CRLF
□ CI 全绿
□ 从 GitHub 干净 clone 跑一遍回归
```

---

## 数据目录（发布相关）

插件数据在 **`~/.dsh/lantern-data/`**（包外），可用 `LANTERN_DATA_DIR` 覆盖。

**发布时绝不能把 `data/` 打进 zip** —— 里面有用户的 API Key 明文。
`.gitignore` 已排除，但手工打 zip 时要再核对一次。

---

## 版本号说明

本仓库自 **1.0.0** 起独立编号（上游 `Saretheya/dsh-lantern` 是 `0.1.x`），
以区分两套代码基。

<!-- 由维护流程验证；最近一次核对：v1.0.2 / v1.0.3 / v1.0.4 / v1.0.5 四个 Release 齐备 -->