'use strict';
/* ============================================================================
 * 传出记录 + 统计 API
 * - 普通用户：仅能创建记录 / 更新自己记录状态 / 查询自己记录与统计
 * - 总管理：可查询全部记录与全局统计，可下载任意记录的备份
 * - 记录元数据 + 可选 content（base64）由桥接上传，服务器备份到 dataDir/backups（保留 retentionDays 天）
 * ========================================================================== */
const Joi = require('joi');
const { asyncHandler, httpError, clientIP } = require('./util');
const { storeBackup, resolveBackup } = require('./backup');

function createRecordsApi(ctx) {
  const { config, db } = ctx;
  const destinations = new Set(config.destinations);
  const statuses = new Set(['sending', 'completed', 'stopped', 'failed']);

  const createSchema = Joi.object({
    destination: Joi.string().valid(...config.destinations).required(),
    filename: Joi.string().min(1).max(255).required(),
    size: Joi.number().integer().min(0).max(1024 * 1024 * 1024).default(0),
    mime: Joi.string().max(200).allow('').default(''),
    isText: Joi.boolean().default(false),
    sha256: Joi.string().max(64).allow('').default(''),
    note: Joi.string().max(500).allow('').default(''),
    // 传输内容（base64，可选；缺失表示不备份，兼容旧客户端）
    content: Joi.string().max(16 * 1024 * 1024).allow('').default(''),
  });

  const updateSchema = Joi.object({
    status: Joi.string().valid('sending', 'completed', 'stopped', 'failed').required(),
    note: Joi.string().max(500).allow('').optional(),
  });

  function canManage(user) {
    return user.role === 'admin';
  }

  function checkOwnership(user, record) {
    if (canManage(user)) return true;
    return record.user_id === user.id;
  }

  /** 严格校验 base64 并解码；非法时抛 400 */
  function decodeContent(b64) {
    if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      throw httpError(400, '备份内容格式无效');
    }
    return Buffer.from(b64, 'base64');
  }

  /* ------------------------------ 创建 ------------------------------ */
  function createRecord(req, res) {
    const { value, error } = createSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);

    // 先校验并解码备份内容（超限/非法时不得建记录）
    let backupBuf = null;
    if (config.backup.enabled && value.content) {
      backupBuf = decodeContent(value.content);
      if (backupBuf.length > config.backup.maxFileBytes) {
        throw httpError(400, `备份内容超过上限（${Math.round(config.backup.maxFileBytes / 1048576)}MB）`);
      }
    }

    const record = db.createRecord({
      userId: req.user.id,
      username: req.user.username,
      filename: value.filename.trim(),
      size: value.size,
      mime: value.mime,
      isText: value.isText,
      destination: value.destination,
      sha256: value.sha256,
      note: value.note,
    });

    if (backupBuf) {
      const rel = storeBackup({ dataDir: config.dataDir, recordId: record.id, filename: record.filename, buffer: backupBuf });
      if (rel) db.setRecordBackup(record.id, rel, backupBuf.length);
    }
    db.audit({ userId: req.user.id, username: req.user.username, action: 'RECORD_CREATE', detail: `${record.filename} → ${value.destination}${backupBuf ? '（含备份）' : ''}`, ip: clientIP(req) });
    res.status(201).json({ ok: true, record: db.getRecord(record.id) });
  }

  /* ------------------------------ 备份下载 ------------------------------ */
  function downloadBackup(req, res, next) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, '无效记录 ID');
    const record = db.getRecord(id);
    if (!record) throw httpError(404, '记录不存在');
    if (!checkOwnership(req.user, record)) throw httpError(403, '无权下载该记录备份');
    const f = resolveBackup({ dataDir: config.dataDir, record });
    if (!f) throw httpError(404, '备份不存在或已过期');
    db.audit({ userId: req.user.id, username: req.user.username, action: 'RECORD_BACKUP_DOWNLOAD', detail: `#${id} ${record.filename}`, ip: clientIP(req) });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(f.absPath, (err) => {
      if (!err) return;
      if (err.code === 'ENOENT') return next(httpError(404, '备份文件已不存在'));
      next(err);
    });
  }

  /* ------------------------------ 更新状态 ------------------------------ */
  function updateStatus(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, '无效记录 ID');
    const { value, error } = updateSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const record = db.getRecord(id);
    if (!record) throw httpError(404, '记录不存在');
    if (!checkOwnership(req.user, record)) throw httpError(403, '无权操作该记录');
    const next = { ...record };
    db.updateRecordStatus(id, value.status, null, value.note !== undefined ? value.note : null);
    db.audit({
      userId: req.user.id,
      username: req.user.username,
      action: 'RECORD_STATUS',
      detail: `#${id} ${record.filename} → ${value.status}`,
      ip: clientIP(req),
    });
    res.json({ ok: true, record: db.getRecord(id) });
  }

  /* ------------------------------ 列表 ------------------------------ */
  function list(req, res) {
    const admin = canManage(req.user);
    const query = {
      destination: String(req.query.destination || '').slice(0, 16),
      status: String(req.query.status || '').slice(0, 16),
      from: String(req.query.from || '').slice(0, 20),
      to: String(req.query.to || '').slice(0, 20),
      q: String(req.query.q || '').slice(0, 64),
    };
    if (query.destination && !destinations.has(query.destination)) throw httpError(400, '无效的目的地');
    if (query.status && !statuses.has(query.status)) throw httpError(400, '无效的状态');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(config.limits.maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || config.limits.pageSize));
    // 普通用户强制只能看自己的记录；总管理可传 userId 筛选
    const userId = admin ? (parseInt(req.query.userId, 10) || 0) : req.user.id;
    const data = db.listRecords({ userId, ...query, page, pageSize });
    res.json({ ...data, isAdmin: admin });
  }

  /* ------------------------------ 单条 ------------------------------ */
  function getOne(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, '无效记录 ID');
    const record = db.getRecord(id);
    if (!record) throw httpError(404, '记录不存在');
    if (!checkOwnership(req.user, record)) throw httpError(403, '无权查看该记录');
    res.json({ record });
  }

  /* ------------------------------ 统计 ------------------------------ */
  function overview(req, res) {
    const userId = canManage(req.user) ? (parseInt(req.query.userId, 10) || 0) : req.user.id;
    res.json({
      ...db.overview(userId),
      byDestination: db.byDestination(userId),
      byUser: canManage(req.user) ? db.byUser(config.limits.maxPageSize) : null,
      userSummary: !canManage(req.user) ? db.userSummary(req.user.id) : null,
    });
  }

  function byDestination(req, res) {
    const userId = canManage(req.user) ? 0 : req.user.id;
    res.json({ rows: db.byDestination(userId) });
  }

  function byUser(req, res) {
    if (!canManage(req.user)) throw httpError(403, '仅总管理可查看每人统计');
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    res.json({ rows: db.byUser(limit) });
  }

  function daily(req, res) {
    const userId = canManage(req.user) ? 0 : req.user.id;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const fromISO = new Date(Date.now() - (days - 1) * 86400000).toISOString();
    res.json({ days, rows: db.daily(fromISO, days) });
  }

  return {
    create: asyncHandler(createRecord),
    updateStatus: asyncHandler(updateStatus),
    list: asyncHandler(list),
    getOne: asyncHandler(getOne),
    downloadBackup: asyncHandler(downloadBackup),
    overview: asyncHandler(overview),
    byDestination: asyncHandler(byDestination),
    byUser: asyncHandler(byUser),
    daily: asyncHandler(daily),
  };
}

module.exports = { createRecordsApi };
