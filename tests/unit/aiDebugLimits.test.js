jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const { requestLimits } = require('../../src/modules/ai/service');
const { turnTimeoutMs } = require('../../src/modules/ai/service/v3Service');

test('production defaults to six admissions per minute while development keeps its existing budget', () => {
  const defaults = { maxRequests: 30, windowMs: 60000, maxConcurrent: 1, queueWaitMs: 30000, maxQueued: 8 };
  for (const NODE_ENV of ['development', 'test']) expect(requestLimits({ NODE_ENV })).toEqual(defaults);
  expect(requestLimits({ NODE_ENV: 'production' })).toEqual({ ...defaults, maxRequests: 6 });
  expect(requestLimits({ NODE_ENV: 'production', AI_RATE_LIMIT_MAX: '9' })).toEqual({ ...defaults, maxRequests: 9 });
  expect(requestLimits({ NODE_ENV: 'production', AI_RATE_LIMIT_MAX: 'bad' })).toEqual({ ...defaults, maxRequests: 6 });
  expect(requestLimits({ NODE_ENV: 'development', AI_RATE_LIMIT_MAX: '120', AI_RATE_LIMIT_WINDOW_MS: '3000', AI_MAX_CONCURRENT_REQUESTS: '4' }))
    .toEqual({ ...defaults, maxRequests: 120, windowMs: 3000, maxConcurrent: 4 });
  expect(requestLimits({ NODE_ENV: 'development', AI_RATE_LIMIT_MAX: '0', AI_RATE_LIMIT_WINDOW_MS: '999', AI_MAX_CONCURRENT_REQUESTS: '0' }))
    .toEqual(defaults);
  expect(requestLimits({ AI_REQUEST_QUEUE_WAIT_MS: '0', AI_REQUEST_QUEUE_MAX: '2' })).toEqual({ ...defaults, queueWaitMs: 0, maxQueued: 2 });
  expect(requestLimits({ AI_REQUEST_QUEUE_WAIT_MS: '-1', AI_REQUEST_QUEUE_MAX: '0' })).toEqual(defaults);
  expect(requestLimits({ AI_REQUEST_QUEUE_WAIT_MS: '', AI_REQUEST_QUEUE_MAX: '' })).toEqual(defaults);
});

test('the V3 turn timeout is longer in development and env-overridable', () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, AI_V3_TURN_TIMEOUT_MS: process.env.AI_V3_TURN_TIMEOUT_MS };
  try {
    process.env.NODE_ENV = 'development'; delete process.env.AI_V3_TURN_TIMEOUT_MS;
    expect(turnTimeoutMs()).toBe(240000);
    process.env.NODE_ENV = 'production';
    expect(turnTimeoutMs()).toBe(120000);
    process.env.AI_V3_TURN_TIMEOUT_MS = '180000';
    expect(turnTimeoutMs()).toBe(180000);
    process.env.AI_V3_TURN_TIMEOUT_MS = '999';
    expect(turnTimeoutMs()).toBe(120000);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
