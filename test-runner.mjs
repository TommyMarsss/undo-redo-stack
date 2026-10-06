#!/usr/bin/env node
/**
 * 零依赖 Node 测试启动器：
 * 直接从 index.html 中抽取 <script id="app-source"> 的源码执行，
 * 保证测试与页面运行的是同一份引擎代码，不产生任何重复实现。
 *
 * 用法：node test-runner.mjs   （全部通过退出码 0，有失败退出码 1）
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, 'index.html'), 'utf8');

const match = html.match(/<script id="app-source">([\s\S]*?)<\/script>/);
if (!match) {
  console.error('未能在 index.html 中找到 <script id="app-source">');
  process.exit(2);
}

// 提供最小全局环境。脚本末尾检测到非浏览器环境后会自动运行测试并 process.exit。
const context = {
  globalThis: undefined,
  console,
  process,
  Date,
  JSON,
  Math,
  Error,
  setTimeout,
};
context.globalThis = context;

vm.createContext(context);
try {
  vm.runInContext(match[1], context, { filename: 'index.html::<app-source>' });
} catch (err) {
  console.error('测试脚本执行异常：', err);
  process.exit(2);
}
