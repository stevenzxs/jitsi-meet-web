import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { compileStyle, parse } from '@vue/compiler-sfc';

const filename = new URL('./src/components/CustomToolbar.vue', import.meta.url);
const source = process.env.TOOLBAR_TEST_GIT_HEAD === '1'
  ? execFileSync('git', ['show', 'HEAD:src/components/CustomToolbar.vue'], { encoding: 'utf8' })
  : readFileSync(filename, 'utf8');
const { descriptor, errors } = parse(source);
assert.deepEqual(errors, []);

test('compiled Android menu styles target descendants, never the page root', () => {
  const selectors = [];
  for (const style of descriptor.styles) {
    const compiled = compileStyle({ source: style.content, filename: filename.pathname,
      id: 'data-v-toolbar-test', scoped: style.scoped });
    assert.deepEqual(compiled.errors, []);
    compiled.rawResult.root.walkRules(rule => selectors.push(...rule.selectors));
  }
  const android = selectors.filter(selector => selector.includes('html.android-embed'));
  assert.ok(android.length > 0, 'Android toolbar styles must be present');
  // 防回归的核心：所有 android-embed 规则必须是"后代选择器"形式（html.android-embed .xxx），
  // 不能退化成仅命中页面根元素的合并选择器（历史上 SFC 编译坑，见 right-gap 调查文档）。
  assert.ok(android.every(selector => selector.startsWith('html.android-embed .')),
    'Android toolbar styles must not leak onto html.android-embed');
  assert.ok(android.includes('html.android-embed .mobile-more-layer'));
  assert.ok(android.includes('html.android-embed .mobile-more-camera-item--active'));
});
