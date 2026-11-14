/**
 * `db/provider-key-cipher.ts` 的四条边界（`PG-09` 写路径的底层不变量）。
 *
 * `tests/providers-admin.spec.ts` 已经从路由层验过「明文不落库 / 能还原 / 只回掩码」；
 * 这里补的是那些**从路由层够不着**的分支：
 *
 *  1. 同一明文加密两次必须得到不同密文（否则「密文相等」泄露「Key 没换过」）；
 *  2. 非 `v1:` 前缀的值原样返回 —— 种子行与裸 SQL 写入的哨兵串靠这一条才能当凭据用；
 *  3. 短 Key 的掩码退化为纯 `••••`（前 3 后 4 在 8 位以下会重叠，等于没遮）；
 *  4. 口令缺失时**抛错**，不静默降级成明文 —— 降级就把红线变成了注释。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptProviderKey,
  encryptProviderKey,
  maskProviderKey,
} from '../db/provider-key-cipher.js';

const SECRET = 'test-only-at-rest-secret-0123456789abcdef';

const saved = process.env['PROVIDER_KEY_SECRET'];

beforeEach(() => {
  process.env['PROVIDER_KEY_SECRET'] = SECRET;
});

afterEach(() => {
  if (saved === undefined) delete process.env['PROVIDER_KEY_SECRET'];
  else process.env['PROVIDER_KEY_SECRET'] = saved;
});

describe('encrypt / decrypt', () => {
  it('往返得到原文', () => {
    const plain = 'sk-live-abcdef1234';
    expect(decryptProviderKey(encryptProviderKey(plain))).toBe(plain);
  });

  it('密文带 v1 前缀，且不含明文', () => {
    const plain = 'sk-live-abcdef1234';
    const ct = encryptProviderKey(plain);
    expect(ct.startsWith('v1:')).toBe(true);
    expect(ct).not.toContain(plain);
  });

  it('同一明文两次加密得到不同密文（随机 IV），但都能解开', () => {
    const plain = 'sk-same-value-9999';
    const a = encryptProviderKey(plain);
    const b = encryptProviderKey(plain);
    expect(a).not.toBe(b);
    expect(decryptProviderKey(a)).toBe(plain);
    expect(decryptProviderKey(b)).toBe(plain);
  });

  it('非 v1 前缀的值原样返回（种子行 / 哨兵串不归本模块编码）', () => {
    expect(decryptProviderKey('fixture-noop-not-a-real-key')).toBe('fixture-noop-not-a-real-key');
    expect(decryptProviderKey('SENTINEL-CIPHERTEXT-MUST-NOT-LEAK-7f3a')).toBe(
      'SENTINEL-CIPHERTEXT-MUST-NOT-LEAK-7f3a',
    );
  });

  it('v1 前缀但密文损坏 ⇒ 抛错（不返回空串，否则 worker 拿垃圾去请求上游）', () => {
    expect(() => decryptProviderKey('v1:not-a-real-ciphertext')).toThrow();
  });

  it('换口令后旧密文解不开 ⇒ 抛错（而不是悄悄返回原文）', () => {
    const ct = encryptProviderKey('sk-live-abcdef1234');
    process.env['PROVIDER_KEY_SECRET'] = 'another-secret-that-is-different-000';
    expect(() => decryptProviderKey(ct)).toThrow();
  });
});

describe('口令缺失', () => {
  it('加密时抛错（绝不静默以明文落库）', () => {
    delete process.env['PROVIDER_KEY_SECRET'];
    expect(() => encryptProviderKey('sk-live-abcdef1234')).toThrow(/PROVIDER_KEY_SECRET/);
  });

  it('解密 v1 密文时抛错', () => {
    const ct = encryptProviderKey('sk-live-abcdef1234');
    delete process.env['PROVIDER_KEY_SECRET'];
    expect(() => decryptProviderKey(ct)).toThrow(/PROVIDER_KEY_SECRET/);
  });

  it('解密非 v1 值时不需要口令（原样通过）', () => {
    delete process.env['PROVIDER_KEY_SECRET'];
    expect(decryptProviderKey('fixture-noop-not-a-real-key')).toBe('fixture-noop-not-a-real-key');
  });
});

describe('maskProviderKey', () => {
  it('常规 Key 只留前 3 后 4', () => {
    expect(maskProviderKey('sk-live-abcdef1234')).toBe('sk-••••1234');
    expect(maskProviderKey('sk-roundtrip-4242')).toBe('sk-••••4242');
  });

  it('短 Key 退化为纯掩码（前 3 后 4 会重叠，等于没遮）', () => {
    expect(maskProviderKey('short')).toBe('••••');
    expect(maskProviderKey('1234567')).toBe('••••');
  });

  it('恰好 8 位时开始显示首尾（不多露一位）', () => {
    expect(maskProviderKey('12345678')).toBe('123••••5678');
  });
});
