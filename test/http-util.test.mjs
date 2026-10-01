import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positiveId, parseIds, contentDisposition } from '../http-util.mjs';

test('id は数字だけの正の整数。NaN や 1e2・0x10・0 は 400', () => {
  assert.equal(positiveId('12', 'x'), 12);
  for (const bad of ['abc', '1e2', '0x10', '0', '-1', '1.5', '', '99999999999999999999']) {
    assert.throws(() => positiveId(bad, 'x'), e => e.status === 400, bad);
  }
});

test('id の並び: 重複を除き順番を保つ。空・上限超えは 400', () => {
  assert.deepEqual(parseIds('3,1,3,2', 10, 'サンプル'), [3, 1, 2]);
  assert.throws(() => parseIds('', 10, 'サンプル'), e => e.status === 400);
  assert.throws(() => parseIds('1,2,3', 2, 'サンプル'), e => e.status === 400 && e.message.includes('2 件'));
  assert.throws(() => parseIds('1,abc', 10, 'サンプル'), e => e.status === 400);
});

test('ファイル名: ASCII に置き換えた名前と UTF-8 の名前を付け、ヘッダを壊す文字を残さない', () => {
  const cd = contentDisposition('sample_試料"1\r\n(a).csv');
  assert.ok(!/[\r\n]/.test(cd));
  assert.match(cd, /^attachment; filename="sample_[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
  const utf8 = cd.split("UTF-8''")[1];
  assert.ok(!/['()"]/.test(utf8));
  assert.equal(decodeURIComponent(utf8), 'sample_試料"1\r\n(a).csv');
});

test('ファイル名: 対になっていないサロゲートでも例外にしない', () => {
  assert.doesNotThrow(() => contentDisposition('sample_\uD800.csv'));
});
