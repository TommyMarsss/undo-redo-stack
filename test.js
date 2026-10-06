#!/usr/bin/env node
/*
 * 自动化测试：零依赖。
 * 直接从 index.html 中提取 <script id="engine"> 的引擎代码并在 Node VM 中执行，
 * 保证被测代码与演示页面实际运行的代码完全同一份。
 *
 * 运行：node test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html 中未找到 <script id="engine">');
  const sandbox = { module: { exports: {} }, console };
  vm.runInNewContext(m[1], sandbox, { filename: 'engine.js' });
  return sandbox.module.exports;
}

const E = loadEngine();
const { TextDoc, InsertCommand, DeleteCommand, ReplaceCommand, History } = E;

/* ---------------- 极简测试框架 ---------------- */
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '值不相等') + ' — 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ---------------- 一、连续相似操作合并 ---------------- */
console.log('\n[一] 连续相似操作的合并');

test('连续单字符插入合并为一个撤销单元（含合并元数据）', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1200));
  h.execute(new InsertCommand(2, 'c', 1400));
  eq(doc.value, 'abc');
  eq(h.undoStack.length, 1, '撤销栈应只有 1 个单元');
  const cmd = h.undoStack[0];
  eq(cmd.text, 'abc', '合并文本应为 abc');
  eq(cmd.mergedCount, 3, 'mergedCount 应为 3');
  eq(cmd.pos, 0, '合并后位置应保持在短语起点');
});

test('合并单元一次撤销撤掉整个短语', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'h', 0));
  h.execute(new InsertCommand(1, 'i', 100));
  eq(h.undoStack.length, 1);
  h.undo();
  eq(doc.value, '', '撤销一次应撤掉整个短语');
  eq(h.undoStack.length, 0);
  eq(h.redoStack.length, 1, '逆命令应进入重做栈');
});

test('插入后接删除：跨操作类型不合并', () => {
  const doc = new TextDoc('ab');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(2, 'c', 1000));   // 'abc'
  h.execute(new DeleteCommand(2, 'c', 1100));   // 立刻退格
  eq(h.undoStack.length, 2, '插入与删除必须各自成单元');
  eq(doc.value, 'ab');
});

test('删除后接插入：跨操作类型不合并', () => {
  const doc = new TextDoc('ab');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new DeleteCommand(1, 'b', 1000));   // 'a'
  h.execute(new InsertCommand(1, 'x', 1100));   // 'ax'
  eq(h.undoStack.length, 2);
});

test('超过时间窗（500ms）不合并', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1501)); // 间隔 501ms
  eq(h.undoStack.length, 2, '明显停顿后应拆分为新单元');
});

test('恰好等于时间窗边界（500ms）合并', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1500)); // 间隔恰好 500ms，<= 合并
  eq(h.undoStack.length, 1);
});

test('时间窗设为 0 时关闭合并', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 0 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1001));
  eq(h.undoStack.length, 2, '关闭合并后每个命令独立');
});

test('光标不在短语末尾邻接位置：不合并（点击别处输入）', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000)); // 'a'
  h.execute(new InsertCommand(0, 'b', 1100)); // 插到开头而非末尾 → 'ba'
  eq(h.undoStack.length, 2, '非邻接输入不得合并');
});

test('多字符插入（粘贴）不并入打字单元', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'bc', 1100)); // 多字符粘贴
  eq(h.undoStack.length, 2);
});

test('已合并单元之后的多字符粘贴不破坏单元结构', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1100)); // 合并 → 'ab'
  h.execute(new InsertCommand(2, 'cd', 1200)); // 粘贴，独立
  eq(h.undoStack.length, 2);
  eq(h.undoStack[0].text, 'ab');
});

test('连续 Backspace 删除合并为一个撤销单元且逆操作精确', () => {
  const doc = new TextDoc('hello');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new DeleteCommand(4, 'o', 1000)); // 'hell'
  h.execute(new DeleteCommand(3, 'l', 1100)); // 'hel'
  h.execute(new DeleteCommand(2, 'l', 1200)); // 'he'
  eq(h.undoStack.length, 1, '连续退格应合并');
  eq(h.undoStack[0].text, 'llo', '合并删除文本应为 llo（每次新删字符拼在前面，起点左移）');
  eq(h.undoStack[0].pos, 2);
  eq(doc.value, 'he');
  h.undo();
  eq(doc.value, 'hello', '一次撤销应恢复全部被删字符');
});

test('连续 ForwardDelete（Fn+Backspace）合并方向正确', () => {
  const doc = new TextDoc('abc');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new DeleteCommand(0, 'a', 1000)); // 删除点不动，右侧补位
  h.execute(new DeleteCommand(0, 'b', 1100));
  eq(h.undoStack.length, 1);
  eq(h.undoStack[0].text, 'ab');
  eq(doc.value, 'c');
  h.undo();
  eq(doc.value, 'abc');
});

test('替换命令永不与任何操作合并', () => {
  const doc = new TextDoc('abc');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new ReplaceCommand(0, 'abc', 'x', 1000)); // 'x'
  h.execute(new InsertCommand(1, 'y', 1100));           // 'xy'
  eq(h.undoStack.length, 2, '替换后插入不得合并');
});

/* ---------------- 二、分支操作后重做栈清空 ---------------- */
console.log('\n[二] 分支操作后重做栈清空');

test('撤销后输入新操作：重做栈立即清空', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 1100));
  h.undo();
  assert(h.redoStack.length === 1, '前置：重做栈应有 1 项');
  h.execute(new InsertCommand(0, 'x', 2000)); // 分支点
  eq(h.redoStack.length, 0, '分支操作必须丢弃全部重做项');
  eq(doc.value, 'x');
});

test('重做栈清空后 redo() 返回 null 且文档不变', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.undo();
  h.execute(new InsertCommand(0, 'z', 2000));
  eq(h.redo(), null, '不应再重做任何东西');
  eq(doc.value, 'z');
});

test('分支后撤销新操作再重做，重做出来的是新操作而非旧分支', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'o', 1000));
  h.execute(new InsertCommand(1, 'l', 1100));
  h.execute(new InsertCommand(2, 'd', 1200)); // 'old' 合并为 1 单元
  h.undo();                                   // ''
  h.execute(new InsertCommand(0, 'n', 2000)); // 'new' 分支，旧分支丢弃
  h.undo();                                   // ''
  eq(doc.value, '');
  h.redo();
  eq(doc.value, 'n', '重做必须恢复新分支内容 n，旧分支 old 永不复活');
  eq(h.redo(), null);
});

test('撤销多步后分支：全部重做项一次性丢弃', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 0 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.execute(new InsertCommand(1, 'b', 2000));
  h.execute(new InsertCommand(2, 'c', 3000));
  h.undo();
  h.undo();
  eq(h.redoStack.length, 2);
  h.execute(new InsertCommand(1, 'X', 4000));
  eq(h.redoStack.length, 0);
  eq(doc.value, 'aX');
});

/* ---------------- 三、精确逆操作与多轮状态一致性 ---------------- */
console.log('\n[三] 精确逆操作 / 多轮 undo·redo 状态一致');

test('插入命令 invert() 是位置文本完全对应的删除命令', () => {
  const cmd = new InsertCommand(3, 'abc');
  const inv = cmd.invert();
  assert(inv instanceof DeleteCommand, '逆命令类型应为 DeleteCommand');
  eq(inv.pos, 3);
  eq(inv.text, 'abc');
  // 逆命令再逆回来
  const back = inv.invert();
  assert(back instanceof InsertCommand);
  eq(back.pos, 3);
  eq(back.text, 'abc');
});

test('删除命令 apply 校验文档内容，不一致时抛错（防误逆操作）', () => {
  const doc = new TextDoc('xyz');
  const bad = new DeleteCommand(0, 'a');
  let threw = false;
  try { bad.apply(doc); } catch (e) { threw = true; }
  assert(threw, '删除位置内容不符必须抛错');
});

test('替换命令的逆操作交换 oldText/newText，多轮往返内容不变', () => {
  const doc = new TextDoc('hello world');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new ReplaceCommand(6, 'world', 'there', 1000)); // 'hello there'
  eq(doc.value, 'hello there');
  h.undo();
  eq(doc.value, 'hello world');
  h.redo();
  eq(doc.value, 'hello there');
  h.undo();
  h.undo(); // 无可撤销，返回 null，文档不变
  eq(doc.value, 'hello world');
  h.redo();
  h.redo();
  eq(doc.value, 'hello there');
});

test('完整场景：每个中间状态与预期快照逐一比对', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  const snap = (label) => ({ label, value: doc.value, u: h.undoStack.length, r: h.redoStack.length });
  const states = [];

  // 连续输入 hello（间隔 100ms）→ 合并成 1 个撤销单元
  'hello'.split('').forEach((ch, i) => {
    h.execute(new InsertCommand(i, ch, 1000 + i * 100));
    states.push(snap('type ' + ch));
  });
  eq(states.at(-1).value, 'hello');
  eq(h.undoStack.length, 1, 'hello 应为 1 个合并单元');

  h.undo(); states.push(snap('undo hello'));
  eq(doc.value, '');
  h.redo(); states.push(snap('redo hello'));
  eq(doc.value, 'hello');

  // 停顿后输入 !（新单元），紧接着退格删掉（删除，跨类型，又是新单元）
  h.execute(new InsertCommand(5, '!', 5000)); states.push(snap('type !'));
  eq(doc.value, 'hello!');
  h.execute(new DeleteCommand(5, '!', 5100)); states.push(snap('backspace !'));
  eq(doc.value, 'hello');

  // 选中替换（永不合并）
  h.execute(new ReplaceCommand(0, 'hello', 'Hi', 5200)); states.push(snap('replace -> Hi'));
  eq(doc.value, 'Hi');

  // 一路撤销：Hi → hello → hello! → hello → ''
  h.undo(); states.push(snap('undo 1')); eq(doc.value, 'hello');
  h.undo(); states.push(snap('undo 2')); eq(doc.value, 'hello!');
  h.undo(); states.push(snap('undo 3')); eq(doc.value, 'hello');
  h.undo(); states.push(snap('undo 4')); eq(doc.value, '');
  eq(h.undoStack.length, 0);
  eq(h.redoStack.length, 4, '4 个撤销单元对应 4 个逆命令');

  // 一路重做，状态序列必须与正向操作时完全一致
  h.redo(); eq(doc.value, 'hello');
  h.redo(); eq(doc.value, 'hello!');
  h.redo(); eq(doc.value, 'hello');
  h.redo(); eq(doc.value, 'Hi');
  eq(h.redoStack.length, 0);
  eq(h.undoStack.length, 4);

  // 再全部撤销/重做一轮，幂等一致
  for (let i = 0; i < 4; i++) h.undo();
  eq(doc.value, '');
  for (let i = 0; i < 4; i++) h.redo();
  eq(doc.value, 'Hi');
});

test('混合合并删除与插入的逆操作往返', () => {
  const doc = new TextDoc('abcdef');
  const h = new History(doc, { mergeInterval: 500 });
  // 连续退格删掉 f、e、d
  h.execute(new DeleteCommand(5, 'f', 1000));
  h.execute(new DeleteCommand(4, 'e', 1100));
  h.execute(new DeleteCommand(3, 'd', 1200));
  eq(doc.value, 'abc');
  eq(h.undoStack.length, 1);
  // 在中间插入（停顿后，独立单元）
  h.execute(new InsertCommand(1, 'X', 3000));
  eq(doc.value, 'aXbc');
  eq(h.undoStack.length, 2);
  h.undo(); eq(doc.value, 'abc', '撤销插入 X');
  h.undo(); eq(doc.value, 'abcdef', '撤销合并删除，精确恢复 def');
  h.redo(); eq(doc.value, 'abc');
  h.redo(); eq(doc.value, 'aXbc');
});

test('clear() 同时清空两个栈', () => {
  const doc = new TextDoc('');
  const h = new History(doc, { mergeInterval: 500 });
  h.execute(new InsertCommand(0, 'a', 1000));
  h.undo();
  h.clear();
  eq(h.undoStack.length, 0);
  eq(h.redoStack.length, 0);
  eq(h.undo(), null);
  eq(h.redo(), null);
});

test('越界位置插入直接抛 RangeError', () => {
  const doc = new TextDoc('ab');
  let threw = false;
  try { doc.insert(9, 'x'); } catch (e) { threw = true; }
  assert(threw);
});

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log('全部测试通过 ✅');
}
