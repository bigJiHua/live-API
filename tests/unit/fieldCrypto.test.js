/**
 * 阶段 10 单元测试：字段级加密（P1-9，device_crypto 握手行 aes_key）
 *
 * 运行：cd api && npx jest tests/unit/fieldCrypto.test.js
 */

const fc = require('../../src/common/utils/fieldCrypto');

describe('加解密 roundtrip', () => {
  it('64hex 握手密钥加密后可解回原值', () => {
    const key = 'a'.repeat(64);
    const enc = fc.encryptField(key);
    expect(fc.decryptField(enc)).toBe(key);
  });

  it('密文带 enc.v1: 前缀 + 3 段 base64url', () => {
    const enc = fc.encryptField('x'.repeat(64));
    expect(enc.startsWith('enc.v1:')).toBe(true);
    expect(enc.slice('enc.v1:'.length).split('.')).toHaveLength(3);
  });

  it('随机 IV：同一明文两次加密结果不同（⚠ 也是邮件行不能加密的原因）', () => {
    const key = 'b'.repeat(64);
    expect(fc.encryptField(key)).not.toBe(fc.encryptField(key));
  });

  it('密文不含明文子串（防"假加密"）', () => {
    const key = 'c'.repeat(64);
    expect(fc.encryptField(key)).not.toContain(key);
  });
});

describe('GCM 篡改检测', () => {
  const key = 'd'.repeat(64);
  const enc = fc.encryptField(key);

  it('篡改 tag 一个字符 ⇒ 抛错（绝不静默返回坏数据）', () => {
    const parts = enc.slice(fc.PREFIX.length).split('.');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[0] ^= 0xff;
    const tampered = `${fc.PREFIX}${parts[0]}.${parts[1]}.${tag.toString('base64url')}`;
    expect(() => fc.decryptField(tampered)).toThrow();
  });

  it('篡改密文段 ⇒ 抛错', () => {
    const parts = enc.slice(fc.PREFIX.length).split('.');
    const ct = Buffer.from(parts[1], 'base64url');
    ct[0] ^= 0xff;
    const tampered = `${fc.PREFIX}${parts[0]}.${ct.toString('base64url')}.${parts[2]}`;
    expect(() => fc.decryptField(tampered)).toThrow();
  });

  it('格式坏（少一段）⇒ 抛错', () => {
    expect(() => fc.decryptField(`${fc.PREFIX}only-one-segment`)).toThrow();
  });
});

describe('存量明文兼容（升级前落库的数据）', () => {
  it('明文 64hex 原样透传，不抛错', () => {
    const legacy = 'e'.repeat(64);
    expect(fc.decryptField(legacy)).toBe(legacy);
  });

  it('邮件行的 userId（纯数字）原样透传', () => {
    expect(fc.decryptField('12345')).toBe('12345');
  });

  it('null / undefined ⇒ 空串，不崩', () => {
    expect(fc.decryptField(null)).toBe('');
    expect(fc.decryptField(undefined)).toBe('');
  });
});

describe('迁移判定 needsReencrypt', () => {
  it('明文握手行 ⇒ true（待迁移）', () => {
    expect(fc.needsReencrypt('f'.repeat(64))).toBe(true);
  });

  it('已加密 ⇒ false', () => {
    expect(fc.needsReencrypt(fc.encryptField('g'.repeat(64)))).toBe(false);
  });

  it('空串 ⇒ false', () => {
    expect(fc.needsReencrypt('')).toBe(false);
  });

  it('邮件行 userId（明文数字）⇒ true（⚠ 调用方必须先排除 email_verify 前缀行）', () => {
    // 这条是文档化断言：needsReencrypt 无法区分"明文密钥"和"明文 userId"，
    // 所以 authSecurityData 的惰性迁移必须同时检查 fingerprint 前缀。
    expect(fc.needsReencrypt('888')).toBe(true);
  });
});

describe('密钥隔离（FIELD_ENCRYPT_KEY 显式配置）', () => {
  it('不同密钥环境的密文互不相通', () => {
    jest.resetModules();
    process.env.FIELD_ENCRYPT_KEY = '1'.repeat(64);
    const fcA = require('../../src/common/utils/fieldCrypto');
    const encA = fcA.encryptField('h'.repeat(64));

    jest.resetModules();
    process.env.FIELD_ENCRYPT_KEY = '2'.repeat(64);
    const fcB = require('../../src/common/utils/fieldCrypto');
    expect(() => fcB.decryptField(encA)).toThrow();

    // 清理，避免影响其他测试文件
    delete process.env.FIELD_ENCRYPT_KEY;
    jest.resetModules();
  });
});

describe('握手链路静态检查（防回退）', () => {
  const fs = require('fs');
  const path = require('path');

  function readCode(rel) {
    return fs
      .readFileSync(path.resolve(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('握手 INSERT 存的是加密值，不再存明文 tempKey', () => {
    const ctrl = readCode('../../src/modules/auth/controller/index.js');
    expect(ctrl).toContain('fieldCrypto.encryptField(tempKey)');
    // INSERT 参数里应是 storedKey
    expect(ctrl).toMatch(/storedKey/);
  });

  it('解密中间件读取时先解密', () => {
    const mw = readCode('../../src/common/middleware/authSecurityData.js');
    expect(mw).toContain('fieldCrypto.decryptField(device.aes_key)');
    expect(mw).not.toMatch(/Hex\.parse\(device\.aes_key\)/);
  });

  it('惰性迁移排除邮件行（fingerprint 前缀检查）', () => {
    const mw = readCode('../../src/common/middleware/authSecurityData.js');
    expect(mw).toContain("startsWith(\"email_verify\")");
  });
});
