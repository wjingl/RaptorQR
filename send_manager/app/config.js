'use strict';
/* ============================================================================
 * 配置加载：config.json（可覆盖默认值）+ 环境变量 RQR_CONFIG 指定路径
 * 默认值见 config.example.json；运行时数据目录解析为绝对路径。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 1145,
  dataDir: './data',
  publicUrl: '',
  session: { absoluteTtlHours: 12, idleTtlMinutes: 30 },
  lockout: { maxFails: 5, windowMinutes: 15, lockMinutes: 15 },
  captcha: { enabled: true, afterFailures: 2, ttlMinutes: 5 },
  password: { minLength: 8, maxLength: 64 },
  registration: { enabled: true },
  batchRegister: { initialPassword: '' },
  admin: {
    bootstrap: {
      enabled: true,
      username: '',
      password: '',
      displayName: '总管理',
      forcePasswordChange: true,
    },
  },
  destinations: ['jzw', 'bgw', 'my', 'sjw'],
  limits: {
    jsonBody: 102400,
    batchBody: 1048576,
    uploadBody: 16777216, // /api/records 上传备份内容用（8MB 文件 base64 后约 11MB）
    pageSize: 50,
    maxPageSize: 100,
    maxConnections: 256,
  },
  backup: {
    enabled: true,        // 是否把传输内容备份到服务器
    retentionDays: 7,     // 备份保留天数，过期由定时任务清理
    maxFileBytes: 8388608, // 单文件备份上限（与前端 8MB 上限一致）
  },
  https: { enabled: false, keyFile: '', certFile: '' },
  security: { trustProxy: false },
};

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override)) {
    const bv = base[k];
    const ov = override[k];
    if (ov !== undefined) {
      out[k] = bv && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv)
        ? mergeDeep(bv, ov)
        : ov;
    }
  }
  return out;
}

function loadConfig() {
  const configPath = process.env.RQR_CONFIG || path.join(ROOT, 'config.json');
  let user = {};
  if (fs.existsSync(configPath)) {
    try {
      user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 解析失败: ${err.message}`);
    }
  }
  const config = mergeDeep(DEFAULTS, user);
  config.configPath = configPath;
  config.dataDir = path.resolve(ROOT, config.dataDir);
  config.destinations = Array.isArray(config.destinations) && config.destinations.length
    ? config.destinations
    : DEFAULTS.destinations;
  // 环境变量可覆盖超级管理员引导配置（部署时免改配置文件）
  if (process.env.RQR_ADMIN_USERNAME) config.admin.bootstrap.username = process.env.RQR_ADMIN_USERNAME;
  if (process.env.RQR_ADMIN_PASSWORD) config.admin.bootstrap.password = process.env.RQR_ADMIN_PASSWORD;
  if (process.env.RQR_ADMIN_DISPLAY) config.admin.bootstrap.displayName = process.env.RQR_ADMIN_DISPLAY;
  return config;
}

/* 默认超级管理员（未配置时使用；首次登录强制改密，见 auth.bootstrapAdmin） */
const DEFAULT_ADMIN = { username: 'admin', password: 'Admin@1145' };

module.exports = { loadConfig, DEFAULTS, ROOT, DEFAULT_ADMIN };
