# 撤销 / 重做命令栈（支持操作合并）

原生 JavaScript（无任何框架、零依赖）实现的文本编辑器撤销/重做系统。单文件演示页 + 可被 Node 直接执行的自动化测试。

- `index.html` — 单文件演示页面（引擎 + DOM 装配 + 调试面板），双击用浏览器打开即可
- `test.js` — 零依赖自动化测试，运行方式：`node test.js`

## 快速开始

```bash
# 跑测试（无需 npm install）
node test.js

# 打开演示页
open index.html        # macOS
# 或直接双击 index.html
```

页面内还提供「运行内置自检」按钮，可在浏览器中即时验证核心不变量。

## 命令模式设计

经典 Command 模式：每次编辑都被建模为一个**命令对象**，命令同时知道如何正向执行与如何精确逆转。

### 文档模型 `TextDoc`

一段纯文本，只暴露三个按位置的、会做边界校验的原语：

| 原语 | 作用 |
| --- | --- |
| `insert(pos, text)` | 在 `pos` 处插入文本 |
| `remove(pos, length)` | 删除并返回被删文本 |
| `replaceRange(pos, oldText, newText)` | 断言 `pos` 处当前内容确为 `oldText` 后替换，不一致即抛错 |

### 命令对象

所有命令继承 `Command`，实现四个接口：`apply(doc)`、`undo(doc)`、`invert()`、`canMerge(next, intervalMs)`。

| 命令 | 记录的数据 | 正向执行 | 精确逆操作 `invert()` |
| --- | --- | --- | --- |
| `InsertCommand(pos, text)` | 插入位置与文本 | 原位插入 | `DeleteCommand(pos, text)` — 删掉同位置同长度文本 |
| `DeleteCommand(pos, text)` | 删除位置与**被删原文** | 校验内容匹配后删除 | `InsertCommand(pos, text)` — 把原文原样插回原处 |
| `ReplaceCommand(pos, oldText, newText)` | 位置、旧文本、新文本 | 断言旧文本匹配后覆盖 | `ReplaceCommand(pos, newText, oldText)` — 新旧互换 |

删除与替换在执行前都会校验文档当前内容是否与命令记录一致，位置越界、内容漂移时直接抛错，避免逆操作作用到错误文本上。

合并元信息（`mergedCount`、`mergeTimes`、`lastTimestamp`）在 `invert()` 时被复制到逆命令上，因此重做栈里看到的逆命令仍带有「×N 已合并」标记。

### 历史栈 `History`

维护两个栈：`undoStack`、`redoStack`。

- `execute(cmd)`：`cmd.apply(doc)` → 尝试与撤销栈栈顶合并 → 否则入栈 → **清空重做栈**。
- `pushApplied(cmd)`：页面 textarea 的变更已由 DOM 先行发生，命令只做记录，合并/清栈规则完全相同。
- `undo()`：弹出 `c`，执行 `c.undo(doc)`，把 `c.invert()` 压入重做栈。
- `redo()`：弹出逆命令 `i`，执行 `i.undo(doc)`（逆命令的 undo 恰好就是重做原操作），再把 `i.invert()` 压回撤销栈。

因为逆命令本身也是完整命令对象，`invert()` 严格对合（`c.invert().invert()` 数据等价于 `c`），多轮 undo/redo 后栈与文档状态保持一致，不存在信息损失。

## 合并判定规则

新命令 `next` 只有在**以下全部条件同时满足**时才并入撤销栈栈顶 `prev`，否则作为新的撤销单元入栈：

1. **同类型**：`next.type === prev.type`。插入只能并入插入，删除只能并入删除；插入后立刻退格（插入→删除）不合并。
2. **单字符**：`next.text.length === 1`，且当前单元每个分片也都是单字符（`prev.text.length === prev.mergedCount`）。逐键输入才合并；粘贴、拖拽写入的多字符文本独立成单元。
3. **光标邻接**：
   - 插入：`next.pos === prev.pos + prev.text.length`（在短语末尾接着打）；点击到别处插入不合并。
   - 删除（连续 Backspace）：`next.pos === prev.pos - 1`，新删字符拼到合并文本前面、起点左移；
   - 删除（连续 ForwardDelete）：`next.pos === prev.pos`（删除点不动、右侧字符补位），新字符拼到后面。
4. **时间窗**：`0 <= next.timestamp - prev.lastTimestamp <= mergeInterval`（默认 500ms，页面可在 0（关闭）/300/500/1000/2000ms 间切换）。
5. **仅连续编辑流**：只有 `execute/pushApplied` 路径参与合并；`undo()` 与 `redo()` 都会把 `lastAction` 置为非 `execute`，撤销/重做后的第一下输入必然开启新单元。
6. **替换不合并**：`ReplaceCommand`（选中选区后输入、粘贴覆盖选区）使用基类默认的 `canMerge → false`，始终独立成单元。

合并采用「就地增长」：栈顶命令的 `text` 被扩展、位置保持在短语起点、`mergedCount++`、`lastTimestamp` 更新——所以一次撤销撤掉的是整个短语。

## 分支操作与重做栈清空

`undo` 之后文档回到了过去某个状态，此时若用户**没有走重做**而是执行了新操作，就产生了一条新的编辑分支。旧分支上的命令如果还留在重做栈里，之后重做会把已不属于当前历史的文本「复活」。

因此 `execute/pushApplied`（包括被合并的输入）的最后一步固定执行：

```js
this.redoStack.length = 0;
```

测试覆盖了：单步撤销后分支、多步撤销后分支（整栈一次性丢弃）、分支后再撤销/重做只会作用于新分支（`old` 永不复活）。

## 演示页与调试面板

- 左侧：文本编辑区、撤销/重做/清空按钮、合并时间窗选择、当前文档快照；
  快捷键 `Ctrl/⌘+Z` 撤销，`Ctrl/⌘+Shift+Z` 或 `Ctrl+Y` 重做。
- 右侧调试面板：实时列出撤销栈、重做栈（栈顶高亮黄色），每条显示
  命令类型徽标（insert/delete/replace）、`describe()` 文本、`id`、`t0/tlast` 时间戳与「已合并 ×N」标记；
  下方操作日志标注 `合并` / 普通执行 / undo / redo / 清空事件。
- DOM 变更通过编辑前后字符串的**最长公共前缀 + 最长公共后缀**推导出唯一的插入/删除/替换命令，再交给同一套引擎入栈，因此页面行为与测试行为共享同一份核心代码。
- 中文输入法组合期间（`compositionstart/end`）不拆分命令，组合结束后整段作为一次输入记录。

## 自动化测试

`test.js` 从 `index.html` 中提取 `<script id="engine">` 片段放进 Node VM 执行——**被测代码就是页面运行的代码**，不存在两份实现。共 24 个用例，分三组：

1. **连续相似操作合并**：连续插入合并为 1 单元、一次撤销撤掉整个短语、跨类型不合并（插入↔删除）、超时/时间窗边界/关闭合并、非邻接输入不合并、多字符粘贴不合并、Backspace 与 ForwardDelete 两个方向的删除合并、替换永不合并。
2. **分支操作后重做栈清空**：撤销后新操作立即清空重做栈、清空后 `redo()` 返回 `null`、分支后再撤销重做只恢复新分支、多步撤销后整栈丢弃。
3. **精确逆操作 / 状态一致性**：`invert()` 对合、删除前内容校验、替换往返、完整场景下每个中间状态与快照逐一比对、两轮全撤销/全重做幂等、`clear()`、越界抛错。
