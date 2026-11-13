'use strict';

const bcrypt = require('bcryptjs');

module.exports = function generateIdentity(ctx) {
  const { add, at, datetime, start, end, days, userId, id } = ctx;
  const mockSalt = '$2b$10$abcdefghijklmnopqrstuu';
  add('user_info', { id: userId, username: 'mock_life', email: 'mock-life@example.invalid',
    avatar: ctx.meta.attachment.url, login_pwd: bcrypt.hashSync(ctx.password, mockSalt),
    pin_code: bcrypt.hashSync(ctx.pin, mockSalt), identity: 'user', status: 1,
    password_changed_at: Number(at(start, '00:00:00')), create_time: at(start, '00:00:00'), update_time: at(end) });
  for (const [index, date] of days.entries()) {
    if (index % 3 !== 0 && date !== end) continue;
    const failed = index % 47 === 0 && index > 0;
    add('user_log', { id: ctx.rows.user_log.length + 1, user_id: userId, type: failed ? 'failed' : 'login',
      token: null, login_ip: '192.0.2.10', login_location: '中国-上海（模拟）', login_isp: '模拟网络',
      user_agent: index % 2 ? 'Synthetic Android browser' : 'Synthetic Windows browser', os_info: index % 2 ? 'Android' : 'Windows',
      browser_info: 'Mock Browser', device_model: 'mock-device', fingerprint: id('device-' + index % 2),
      viewport: index % 2 ? '390x844' : '1440x900', pixel_ratio: '1', status: failed ? 0 : 1,
      error_message: failed ? '模拟登录失败' : null, login_lang: 'zh-CN', path: '/login',
      login_time: at(date, '08:00:00'), create_time: at(date, '08:00:00') });
    if (index % 15 === 0) add('security_verify_log', { id: ctx.rows.security_verify_log.length + 1,
      user_id: userId, request_url: '/api/v1/card/list', action_type: 'view', pin_status: failed ? 2 : 1,
      error_count: failed ? 1 : 0, verify_expire_time: datetime(date, '08:15:00'),
      remark: '合成历史验证事件', create_time: datetime(date, '08:00:00') });
  }
  for (let index = 0; index < 2; index++) add('device_crypto', { fingerprint: id('device-' + index), scene: 'login',
    aes_key: null, aes_expires_at: 0, captcha_code: null, captcha_expires_at: 0,
    captcha_attempts: 0, captcha_verified: 0, client_ip: '192.0.2.10', user_agent: 'Synthetic browser',
    fail_count: 0, locked_until: 0, created_at: Number(at(start)), updated_at: Number(at(end)) });
};
