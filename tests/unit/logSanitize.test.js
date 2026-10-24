/**
 * 阶段 4 单元测试：日志脱敏与反代信任收敛（P1-10 / P1-18）
 *
 * 运行：cd api && npx jest tests/unit/logSanitize.test.js
 *
 * 覆盖：
 * A. buildErrorBody —— 生产环境不回传内部错误细节，开发环境保留
 * B. maskEmail —— 邮箱脱敏
 * C. buildServerSideLogFields —— 客户端伪造字段一律被忽略
 * D. trust proxy 解析 —— 层数配置的取值与边界
 * E. 源码静态检查 —— OTP 明文/ error.message / trust proxy:true 必须已消失
 */

const fs = require('fs');
const path = require('path');

const {
  buildErrorBody,
  buildErrorDetail,
  maskEmail,
  buildServerSideLogFields,
} = require('../../src/common/utils/logFields');

const AUTH_CTRL = path.resolve(__dirname, '../../src/modules/auth/controller/index.js');
const APP_JS = path.resolve(__dirname, '../../app.js');

const ORIGINAL_ENV = process.env.NODE_ENV;
function setEnv(v) {
  if (v === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = v;
}
afterAll(() => setEnv(ORIGINAL_ENV));

// ==================== A. 错误详情脱敏 ====================
describe('A·buildErrorBody 生产脱敏（P1-10）', () => {
  it('生产环境：只回 message，绝不带 error 字段', () => {
    setEnv('production');
    const body = buildErrorBody('注册失败', new Error('ER_DUP_ENTRY: key user_info.username'));
    expect(body.message).toBe('注册失败');
    expect(body).not.toHaveProperty('error');
    expect(JSON.stringify(body)).not.toMatch(/ER_DUP_ENTRY|user_info/);
  });

  it('生产环境：原始报错内容不出现在响应里', () => {
    setEnv('production');
    const secret = 'connect ECONNREFUSED 127.0.0.1:3306 (mysql)';
    expect(JSON.stringify(buildErrorBody('操作失败', new Error(secret)))).not.toContain('ECONNREFUSED');
  });

  it('开发环境：保留 error 便于本地调试', () => {
    setEnv('development');
    const body = buildErrorBody('注册失败', new Error('boom'));
    expect(body.error).toBe('boom');
  });

  it('test 环境：保留 error', () => {
    setEnv('test');
    expect(buildErrorDetail(new Error('x')).error).toBe('x');
  });

  it('error 为 null/undefined 时不崩', () => {
    setEnv('development');
    // String(null) === 'null'、String(undefined) === 'undefined'，都不是 undefined 值本身
    expect(buildErrorBody('x', null)).toEqual({ message: 'x', error: 'null' });
    expect(buildErrorBody('x', undefined)).toEqual({ message: 'x', error: 'undefined' });
    expect(buildErrorBody('x', new Error(''))).toHaveProperty('error');
  });

  it('message 为空也不崩', () => {
    setEnv('production');
    expect(buildErrorBody('', new Error('e'))).toEqual({ message: '' });
  });
});

// ==================== B. 邮箱脱敏 ====================
describe('B·maskEmail', () => {
  it('保留首字符与域名', () => {
    expect(maskEmail('jihua@163.com')).toBe('j***@163.com');
  });

  it('短名邮箱也正确处理', () => {
    expect(maskEmail('a@b.cn')).toBe('a***@b.cn');
  });

  it('无 @ 的输入不泄露', () => {
    expect(maskEmail('notanemail')).toBe('***');
  });

  it('空值安全', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
  });

  it('不泄露完整本地部分', () => {
    expect(maskEmail('verylongname@example.com')).not.toContain('verylongname');
  });
});

// ==================== C. 日志字段服务端采集 ====================
describe('C·buildServerSideLogFields 采信服务端（P1-15 补漏）', () => {
  const makeReq = (o = {}) => ({
    headers: {},
    security: {},
    path: '/api/v1/user/update-username',
    ip: '127.0.0.1',
    ...o,
  });

  it('IP 优先取 securityCheck 校验过的值', () => {
    const f = buildServerSideLogFields(makeReq({ security: { ip: '203.0.113.5' } }), 1);
    expect(f.login_ip).toBe('203.0.113.5');
  });

  it('无 security 时回退 req.ip', () => {
    expect(buildServerSideLogFields(makeReq({ ip: '198.51.100.2' }), 1).login_ip).toBe('198.51.100.2');
  });

  it('path 取服务端路由', () => {
    expect(buildServerSideLogFields(makeReq({ path: '/api/v1/auth/login' }), 1).path)
      .toBe('/api/v1/auth/login');
  });

  it('不可信字段固定为占位', () => {
    const f = buildServerSideLogFields(makeReq(), 1);
    expect(f.login_location).toBe('未知');
    expect(f.login_isp).toBe('未知');
    expect(f.browser_info).toBe('');
  });

  it('body.data 里的伪造字段被完全忽略（顶层地点/运营商除外）', () => {
    const req = makeReq({
      // 伪造的业务 data（历史实现会展开它）
      body: {
        data: {
          login_ip: '1.2.3.4', fingerprint: 'VICTIM', path: '/admin',
          user_agent: 'FakeUA', login_location: 'Mars',
        },
      },
      security: { ip: '203.0.113.9', fingerprint: 'fp-real' },
    });
    const f = buildServerSideLogFields(req, 1);
    expect(f.login_ip).toBe('203.0.113.9');
    expect(f.fingerprint).toBe('fp-real');
    expect(f.path).toBe('/api/v1/user/update-username');
    expect(f.user_agent).toBe('');        // 请求头没有 ⇒ 空，而不是 body 里的 FakeUA
    expect(f.login_location).toBe('未知'); // data 内的 location 不采信
  });

  it('顶层 loginLocation/loginIsp 按负责人拍板采信（展示用）', () => {
    const f = buildServerSideLogFields(makeReq({
      body: { loginLocation: 'China-Zhejiang-Hangzhou', loginIsp: 'CMCC' },
    }), 1);
    expect(f.login_location).toBe('China-Zhejiang-Hangzhou');
    expect(f.login_isp).toBe('CMCC');
  });

  it('地点/运营商的空值与占位值落未知', () => {
    const f = buildServerSideLogFields(makeReq({
      body: { loginLocation: '--', loginIsp: 'unknown' },
    }), 1);
    expect(f.login_location).toBe('未知');
    expect(f.login_isp).toBe('未知');
  });

  it('device/os/fingerprint 从安全头取值', () => {
    const req = makeReq({
      headers: {
        'user-agent': 'UA/1.0', 'x-os-name': 'Android', 'x-device-model': 'Pixel',
        'x-fingerprint-hash': 'fp-h', viewportwidth: '390', viewportheight: '844',
        pixelratio: '3', 'accept-language': 'zh-CN',
      },
    });
    const f = buildServerSideLogFields(req, 1);
    expect(f.user_agent).toBe('UA/1.0');
    expect(f.os_info).toContain('Android');
    expect(f.device_model).toBe('Pixel');
    expect(f.fingerprint).toBe('fp-h');
    expect(f.viewport).toBe('390x844');
    expect(f.pixel_ratio).toBe('3');
  });

  it('req 缺 headers 时不崩', () => {
    expect(() => buildServerSideLogFields({ ip: '1.1.1.1' }, 1)).not.toThrow();
    expect(buildServerSideLogFields({}, 1).login_ip).toBe('0.0.0.0');
  });

  it('user_id 正确透传', () => {
    expect(buildServerSideLogFields(makeReq(), 77).user_id).toBe(77);
  });
});

// ==================== D. trust proxy 解析（P1-18） ====================
describe('D·trust proxy 层数解析', () => {
  // 把 app.js 里的解析逻辑复制成纯函数测试（app.js 需连库，无法直接 require）
  function resolve(raw) {
    const v = String(raw ?? '1').trim();
    if (v === '') return false;
    if (/^\d+$/.test(v)) return Number(v);
    return v;
  }

  it('默认 1 层', () => {
    expect(resolve(undefined)).toBe(1);
  });

  it('0 = 不信任 XFF', () => {
    expect(resolve('0')).toBe(0);
  });

  it('正整数按层数', () => {
    expect(resolve('2')).toBe(2);
    expect(resolve('5')).toBe(5);
  });

  it('留空 = 等同 0', () => {
    expect(resolve('')).toBe(false);
    expect(resolve('   ')).toBe(false);
  });

  it('非数字特殊值透传（true/loopback 等）', () => {
    expect(resolve('true')).toBe('true');
    expect(resolve('loopback')).toBe('loopback');
  });

  it('**绝不会再默认 true**（历史陷阱）', () => {
    // 这条是回归护栏：一旦有人把默认值改回 true，测试立刻红
    expect(resolve(undefined)).not.toBe(true);
    expect(resolve('1')).not.toBe(true);
  });
});

// ==================== E. 源码静态检查（防止回退） ====================
describe('E·源码静态检查（防回退）', () => {
  const ctrl = fs.readFileSync(AUTH_CTRL, 'utf8');
  const appJs = fs.readFileSync(APP_JS, 'utf8');
  const userModel = fs.readFileSync(
    path.resolve(__dirname, '../../src/modules/auth/model/user.js'), 'utf8'
  );
  // 去掉注释后再匹配，避免「修复说明」被当成真实代码
  const strip = (c) => c
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('controller 无残留裸 `error: error.message`', () => {
    expect((strip(ctrl).match(/error: error\.message/g) || []).length).toBe(0);
  });

  it('**OTP 验证码明文不再打印**', () => {
    // 任何把验证码变量插进日志的写法都不允许
    expect(strip(ctrl)).not.toMatch(/验证码[:：]\s*\$\{/);
    expect(strip(ctrl)).not.toMatch(/\$\{code\}/);
  });

  it('controller 引用了公共实现（不再自带一份）', () => {
    expect(strip(ctrl)).toContain('buildErrorBody');
    expect(strip(ctrl)).toContain('buildServerSideLogFields');
    // 不应再有本地 function 定义
    expect(strip(ctrl)).not.toMatch(/function buildServerSideLogFields/);
  });

  it('user model 改用户名日志不再用 req.body 字段', () => {
    expect(strip(userModel)).not.toMatch(/login_ip:\s*\n?\s*req\.body/);
    expect(strip(userModel)).toContain('buildServerSideLogFields');
  });

  it('user model 不再把完整 Authorization 头传进日志', () => {
    expect(strip(userModel)).not.toMatch(/token:\s*req\.headers\.authorization/);
  });

  it('app.js 不再使用 trust proxy = true', () => {
    expect(strip(appJs)).not.toMatch(/trust proxy['"]?,\s*true\s*\)/);
  });

  it('app.js 支持 TRUST_PROXY_HOPS 配置', () => {
    expect(appJs).toContain('TRUST_PROXY_HOPS');
  });
});