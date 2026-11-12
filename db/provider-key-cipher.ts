/**
 * 厂商 API Key 的落库编码（`工程规则.md` §9「契约层只写不读」的物理兑现）。
 *
 * ## 它解决的不是「加密」，是「不可能读回来」
 *
 * 契约里 `ModelProviderCreate.apiKey` 存在、`ModelProvider` 里没有——这个**非对称**
 * 才是防线。本文件只负责让这份非对称在数据库这一层也成立：明文进、密文出，
 * 且密文只在 `getProviderForExecution()` 这一处被还原（worker 构造 Bearer 时）。
 *
 * ## 三个函数，各自钉住一条不变量
 *
 *  - `encryptProviderKey`：明文**绝不**原样进列。每次加密用随机 IV，同一把 Key
 *    两次入库得到不同密文（否则「密文相等」本身就泄露「Key 没换过」）。
 *  - `decryptProviderKey`：只认自己产出的 `v1:` 前缀。**非本格式的值原样返回**——
 *    这不是宽容，是必需：种子行（`fixture-noop-not-a-real-key`）与测试里用裸 SQL
 *    直接写入的哨兵串都必须是可读的可用凭据，否则
 *    `tests/provider-secret-leak.spec.ts` 会在「修复泄密」时把「可用性」一起改坏。
 *  - `maskProviderKey`：只留前 3 后 4，中间恒为 `••••`。**长度不足时退化为纯掩码**，
 *    宁可什么都不显示，也不为了好看而多露一位。
 *
 * ## 口令从哪来
 *
 * `PROVIDER_KEY_SECRET`，**每次调用时现读**，不在模块加载时快照。
 * 原因很实际：测试在 `beforeAll` 里才设它（那时模块早已被 import），
 * 模块级快照会让整份测试读到一个 `undefined` 口令。
 *
 * 口令缺失时不静默降级成明文（那就是把红线写成注释），直接抛错——
 * 写路径变成 500、读路径让 worker 拿不到凭据，两者都会立刻暴露配置问题。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 密文格式前缀。`v1` 留给将来的换算法/换口令迁移。 */
const PREFIX = 'v1:';

/** AES-256-GCM：12 字节 IV、16 字节 tag，是 GCM 的标准取值。 */
const IV_BYTES = 12;

/** 掩码中间那段。用 `•`（U+2022）而非 `*`：视觉上不可能被误当成 Key 的一部分。 */
const ELLIPSIS = '••••';

/**
 * 从环境变量派生 32 字节密钥。
 *
 * 用 SHA-256 而不是 KDF：口令本身由部署方给足熵（见 `.env.example` 的占位说明），
 * 这里要的是「长度对齐」，不是「抗暴力」。真要做口令强化，得配 salt 与迭代次数，
 * 那是另一件事，不该悄悄塞进一个派生函数里。
 */
function masterKey(): Buffer {
  const secret = process.env['PROVIDER_KEY_SECRET'];
  if (secret === undefined || secret === '') {
    throw new Error(
      '缺少 PROVIDER_KEY_SECRET：无法加密/解密厂商 API Key（拒绝以明文落库）',
    );
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 明文 → 密文串（`v1:<iv>:<tag>:<ct>`，各段 base64）。 */
export function encryptProviderKey(plain: string): string {
  const key = masterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * 密文串 → 明文。
 *
 * **非 `v1:` 前缀一律原样返回**（见文件头第 2 条）：种子行与测试哨兵是裸值，
 * 它们本来就是「可直接当 Bearer 用的」东西，不归本文件编码。
 *
 * `v1:` 前缀但解不开（口令换了 / 密文被改）⇒ **抛错**。
 * 绝不返回空串或原文：那会让 worker 拿着垃圾去请求上游，把配置问题伪装成「鉴权失败」。
 */
export function decryptProviderKey(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;

  const parts = stored.slice(PREFIX.length).split(':');
  const [ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 3 || ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error('厂商 API Key 密文格式不完整，无法解密');
  }

  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/**
 * 明文 → 可回传的掩码（形如 `sk-••••3f2a`）。
 *
 * 只保留前 3 后 4。长度不足 8 时退化为纯 `••••`：
 * 短 Key 的「前 3 后 4」几乎就是全长，掩码会变成泄露。
 */
export function maskProviderKey(plain: string): string {
  // 少于 8 位时，前 3 + 后 4 会重叠，掩码形同虚设
  if (plain.length < 8) return ELLIPSIS;
  return `${plain.slice(0, 3)}${ELLIPSIS}${plain.slice(-4)}`;
}
