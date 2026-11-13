'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseLiveSql } = require('../../src/init/schemaSync');

const DAY_MS = 86400000;
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function createStatements(source) {
  const tables = {};
  const pattern = /CREATE TABLE IF NOT EXISTS\s+`([A-Za-z0-9_]+)`/g;
  let match;
  while ((match = pattern.exec(source))) {
    let quote = null;
    let end = match.index;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote && character === '\\') { end++; continue; }
      if (quote && character === quote && source[end + 1] === quote) { end++; continue; }
      if (character === quote) quote = null;
      else if (!quote && ["'", '"', '`'].includes(character)) quote = character;
      else if (!quote && character === ';') break;
    }
    if (end === source.length) throw new Error('CREATE TABLE 缺少结尾：' + match[1]);
    tables[match[1]] = source.slice(match.index, end + 1);
    pattern.lastIndex = end + 1;
  }
  return tables;
}
function checkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    throw new Error('无效日期：' + value);
  return value;
}
function addDays(date, count) {
  return new Date(Date.parse(checkDate(date) + 'T00:00:00Z') + count * DAY_MS).toISOString().slice(0, 10);
}
function todayShanghai(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function threeYearsAgo(end) {
  const year = Number(end.slice(0, 4)) - 3;
  const candidate = year + end.slice(4);
  // A leap-day endpoint maps to February 28 in a non-leap start year.
  return new Date(candidate + 'T00:00:00Z').toISOString().slice(0, 10) === candidate
    ? candidate : year + '-02-28';
}
function createContext({ end = todayShanghai(), start = threeYearsAgo(end), seed = 'live-three-years-v1', password = 'MockLive2026!', pin = '246810' } = {}) {
  checkDate(start); checkDate(end);
  if (start > end || end > todayShanghai()) throw new Error('日期范围必须从过去起始日截至今天或更早');
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS > 3653) throw new Error('单用户生成范围最多十年');
  const schema = parseLiveSql();
  // schemaSync's DDL regex ends at a semicolon inside an SQL COMMENT. Keep its
  // column metadata, but extract whole executable statements with quoted text.
  const statements = createStatements(fs.readFileSync(path.resolve(__dirname, '../../mysql/live.sql'), 'utf8'));
  for (const [table, definition] of Object.entries(schema)) definition.createSql = statements[table];
  // 008 is still absent from live.sql; include its column in fresh mock exports.
  if (!schema.user_info.columns.some(column => column.name === 'password_changed_at')) {
    schema.user_info.columns.push({ name: 'password_changed_at', type: 'bigint', nullable: true, defaultValue: 'NULL', extra: '' });
    schema.user_info.createSql = schema.user_info.createSql.replace('  PRIMARY KEY (`id`)',
      "  `password_changed_at` BIGINT NULL DEFAULT NULL COMMENT '密码最后修改时间戳(ms)',\n  PRIMARY KEY (`id`)");
  }
  const days = [];
  for (let date = start; date <= end; date = addDays(date, 1)) days.push(date);
  const months = [...new Set(days.map(date => date.slice(0, 7)))];
  const rows = Object.fromEntries(Object.keys(schema).map(table => [table, []]));
  let state = parseInt(digest(seed).slice(0, 8), 16) >>> 0;
  const random = () => { state = (state + 0x6D2B79F5) >>> 0; let x = state; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const id = key => {
    const h = digest(seed + ':' + key);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const at = (date, time = '12:00:00') => String(Date.parse(date + 'T' + time + '+08:00'));
  const datetime = (date, time = '12:00:00') => date + ' ' + time;
  const userId = id('user');
  // These keys belong exclusively to reproducible synthetic data, never a live account.
  const fieldKey = digest('mock-field-key:' + seed);
  const encryptionKey = crypto.createHash('sha256').update(fieldKey).digest();
  const encrypt = (plaintext, key) => {
    const iv = crypto.createHmac('sha256', encryptionKey).update(String(key) + ':' + plaintext).digest().subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const content = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return 'enc.v1:' + [iv, content, cipher.getAuthTag()].map(part => part.toString('base64url')).join('.');
  };
  const money = cents => {
    if (!Number.isSafeInteger(cents)) throw new Error('金额必须使用整数分');
    return (cents < 0 ? '-' : '') + Math.floor(Math.abs(cents) / 100) + '.' + String(Math.abs(cents) % 100).padStart(2, '0');
  };
  const add = (table, row) => {
    if (!schema[table]) throw new Error('未知表：' + table);
    const cols = schema[table].columns;
    for (const column of cols) {
      if (Object.hasOwn(row, column.name)) continue;
      if (column.name === 'user_id') row.user_id = userId;
      if (column.name === 'is_deleted') row.is_deleted = 0;
      if (['create_time', 'update_time'].includes(column.name)) {
        const date = column.name === 'create_time' ? start : end;
        row[column.name] = /^(timestamp|datetime)/i.test(column.type) ? datetime(date) : at(date);
      }
    }
    rows[table].push(row);
    return row;
  };
  return { start, end, seed, password, pin, schema, days, months, rows, userId, id, at, datetime, addDays, random,
    int: (min, max) => min + Math.floor(random() * (max - min + 1)), money, add, digest, encrypt, fieldKey, meta: {} };
}

module.exports = { createContext, checkDate, addDays, todayShanghai, threeYearsAgo, digest, createStatements };
