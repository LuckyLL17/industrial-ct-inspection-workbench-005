import Fastify from 'fastify';
import cors from '@fastify/cors';
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
// DELETE 等请求常带 content-type: application/json 但没有 body：将空 body 解析为 {}，
// 使路由仍能执行（默认解析器会在进路由前直接 400）
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = (body ?? '').toString().trim();
  if (!text) return done(null, {});
  try { done(null, JSON.parse(text)); } catch (err) { (err as any).statusCode = 400; done(err as any, undefined); }
});
app.setErrorHandler((error: any, _request, reply) => {
  const status = error.statusCode ?? 500;
  reply.status(status).send({ statusCode: status, code: error.code ?? 'internal_error', message: error.message });
});

type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';
type Annotation = { id: string; axis: string; index: number; x: number; y: number; kind: string; severity: string; note: string; diameter: number; confidence: number; reviewStatus: ReviewStatus; reviewer?: string; createdAt: string };
const scan = { id: 'valve-housing-017', part: '液压阀体 / VH-017', material: 'AlSi10Mg', resolution: '42 μm', dimensions: '128 × 128 × 96 voxels', operator: '张工', acquiredAt: '2026-09-30 08:42', scanner: 'Phoenix v|tome|x M 300', lot: 'LOT-2026-09-A17', standard: 'ASTM E1441' };
let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];
const workflow = [
  { id: 'ingest', label: '数据接收', status: 'done', owner: '系统', detail: '原始 DICOM 序列已校验' },
  { id: 'reconstruct', label: '体数据重建', status: 'done', owner: '算法服务', detail: '96 层切片已生成' },
  { id: 'primary', label: '初检标注', status: 'active', owner: '张工', detail: '存在 3 个候选缺陷' },
  { id: 'review', label: '二次复核', status: 'pending', owner: '王工', detail: '等待高风险裂纹复核' },
  { id: 'release', label: '报告签发', status: 'pending', owner: '质量负责人', detail: '需完成复核与判定' }
];

// ─────────────────────────────────────────────────────────────
// 复核历史：独立于标注表的追加式（append-only）事件存储
// 取舍说明：不从当前标注反推历史——反推无法还原中间状态、
// 备注历次变化、删除事件与真实发生时间。事件只追加、不修改、
// 不随标注删除而删除；每个事件携带当时的标注快照，可回溯切片。
// ─────────────────────────────────────────────────────────────
type ReviewEventType = 'created' | 'note_changed' | 'status_changed' | 'accepted' | 'rejected' | 'deleted';
type EventOrigin = 'live' | 'backfill' | 'synthetic';
type AnnotationSnapshot = Pick<Annotation, 'axis' | 'index' | 'x' | 'y' | 'kind' | 'severity' | 'note' | 'diameter' | 'confidence' | 'reviewStatus' | 'reviewer' | 'createdAt'> & { deleted: boolean };
type ReviewEvent = {
  seq: number; // 全局单调递增，事件顺序的权威依据
  id: string;
  annotationId: string;
  type: ReviewEventType;
  actor: string;
  at: string; // ISO 发生时间
  detail?: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  noteBefore?: string;
  noteAfter?: string;
  origin: EventOrigin;
  snapshot: AnnotationSnapshot;
};
const REVIEW_EVENT_TYPES: ReviewEventType[] = ['created', 'note_changed', 'status_changed', 'accepted', 'rejected', 'deleted'];
const VALID_STATUSES: ReviewStatus[] = ['unreviewed', 'in_review', 'accepted', 'rejected'];

let reviewHistory: ReviewEvent[] = [];
let eventSeq = 0;
// 幂等去重：显式幂等键长期保留；无键的内容指纹仅保留 60s 窗口，覆盖网络重试/双击
const idemStore = new Map<string, { ts: number; result: unknown }>();
const IDEM_WINDOW_MS = 60_000;

function snapshotOf(a: Annotation, deleted = false): AnnotationSnapshot {
  return { axis: a.axis, index: a.index, x: a.x, y: a.y, kind: a.kind, severity: a.severity, note: a.note, diameter: a.diameter, confidence: a.confidence, reviewStatus: a.reviewStatus, reviewer: a.reviewer, createdAt: a.createdAt, deleted };
}
function appendReviewEvent(input: Omit<ReviewEvent, 'seq' | 'id' | 'at' | 'origin'> & { at?: string; origin?: EventOrigin }): ReviewEvent {
  const { at, origin, ...rest } = input;
  const event: ReviewEvent = { seq: ++eventSeq, id: `EV-${String(eventSeq).padStart(5, '0')}`, at: at ?? new Date().toISOString(), origin: origin ?? 'live', ...rest };
  reviewHistory.push(event);
  return event;
}
// 旧数据没有历史：启动时按 createdAt 顺序回填 created 事件，seq 排在一切实时事件之前
function backfillHistory() {
  annotations.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach(a => {
    appendReviewEvent({ type: 'created', annotationId: a.id, actor: '系统（旧数据回填）', detail: '该缺陷早于复核历史功能上线，创建事件由旧数据回填', at: a.createdAt, origin: 'backfill', snapshot: snapshotOf(a) });
  });
}
backfillHistory();
// 防御性合成：读取时若发现某标注连 created 事件都没有（例如存储被重置），
// 合成事件只在响应中返回、不落库，因此永远不会与真实事件重复。
function syntheticCreated(a: Annotation): ReviewEvent {
  return { seq: 0, id: `SYN-${a.id}`, annotationId: a.id, type: 'created', actor: '系统（读取时合成）', detail: '未找到该缺陷的创建事件，依据当前标注合成', at: a.createdAt, origin: 'synthetic', snapshot: snapshotOf(a) };
}

type SelectOpts = { annotationId?: string; type?: ReviewEventType; after?: number; limit?: number };
function selectEvents(opts: SelectOpts = {}) {
  const createdIds = new Set(reviewHistory.filter(e => e.type === 'created').map(e => e.annotationId));
  const synthetic = annotations.filter(a => !createdIds.has(a.id)).map(syntheticCreated);
  // 发生顺序：先按 at，同一毫秒内以全局 seq 决胜
  let items = [...reviewHistory, ...synthetic].sort((p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : p.seq - q.seq));
  if (opts.annotationId) items = items.filter(e => e.annotationId === opts.annotationId);
  if (opts.type) items = items.filter(e => e.type === opts.type);
  if (opts.after && opts.after > 0) items = items.filter(e => e.seq > opts.after!);
  const total = items.length;
  if (opts.limit && opts.limit > 0) {
    // 带 after 游标时按顺序取第一页；无游标时 limit 表示“最近 N 条”
    items = opts.after && opts.after > 0 ? items.slice(0, opts.limit) : items.slice(-opts.limit);
  }
  const counts = REVIEW_EVENT_TYPES.reduce<Record<string, number>>((out, t) => { out[t] = items.filter(e => e.type === t).length; return out; }, {});
  return { items, total, counts, lastSeq: items.length ? items[items.length - 1].seq : opts.after ?? 0 };
}

// 重复投递防护：优先使用客户端幂等键；否则退化为“对象+内容指纹”短窗口去重
function withIdempotency<T extends object>(idemKey: string | undefined, signature: string, produce: () => T): T & { deduped?: boolean } {
  const keyId = idemKey ? `key:${idemKey}` : undefined;
  const keySig = `sig:${signature}`;
  // 幂等键与“对象+内容指纹”两个维度同时检查，避免无键/带键混用导致重复执行
  for (const k of [keyId, keySig]) {
    if (!k) continue;
    const hit = idemStore.get(k);
    if (hit && (k.startsWith('key:') || Date.now() - hit.ts < IDEM_WINDOW_MS)) {
      return { ...(hit.result as object), deduped: true } as T & { deduped?: boolean };
    }
  }
  const result = produce();
  const entry = { ts: Date.now(), result };
  idemStore.set(keySig, entry);
  if (keyId) idemStore.set(keyId, entry);
  return result;
}
function httpError(statusCode: number, code: string, message: string) {
  const e: any = new Error(message); e.statusCode = statusCode; e.code = code; return e;
}
function failIfAsked(request: { query: unknown; headers: unknown }) {
  const q = request.query as { simulateFailure?: string };
  const h = request.headers as Record<string, string | undefined>;
  if (q.simulateFailure === '1' || h['x-simulate-failure'] === '1') throw httpError(503, 'simulated_failure', '模拟的复核历史读取失败（simulateFailure=1）');
}
function idemKeyOf(request: { headers: unknown; body?: unknown }) {
  const h = request.headers as Record<string, string | undefined>;
  const b = (request.body ?? {}) as { idempotencyKey?: string };
  return h['x-idempotency-key'] ?? b.idempotencyKey;
}

function slice(axis: string, index: number) { const size = 96; const data: number[][] = []; for (let y = 0; y < size; y++) { const row: number[] = []; for (let x = 0; x < size; x++) { const dx = x - 48, dy = y - 48; const shell = Math.sqrt(dx * dx + dy * dy); let value = 12 + Math.max(0, 1 - Math.abs(shell - 31) / 9) * 130 + Math.max(0, 1 - Math.abs(shell - 14) / 5) * 48; value += 16 * Math.sin((x + index) * .17) * Math.cos((y - index) * .12); const hole = (x - (57 + Math.sin(index * .15) * 4)) ** 2 + (y - (39 + Math.cos(index * .1) * 3)) ** 2; if (hole < 28 + (index - 42) ** 2 * .7) value = 8; const inclusion = (x - 30) ** 2 + (y - 61) ** 2; if (inclusion < 13 && axis !== 'sagittal') value = 220; row.push(Math.max(0, Math.min(255, Math.round(value)))); } data.push(row); } return { axis, index, size, data }; }
function stats() { return { defectCount: annotations.length, criticalCount: annotations.filter(item => item.severity === '高').length, unreviewedCount: annotations.filter(item => item.reviewStatus !== 'accepted' && item.reviewStatus !== 'rejected').length, totalVolume: +annotations.reduce((sum, item) => sum + 4 / 3 * Math.PI * (item.diameter / 2) ** 3, 0).toFixed(2), byKind: Object.entries(annotations.reduce<Record<string, number>>((out, item) => { out[item.kind] = (out[item.kind] ?? 0) + 1; return out; }, {})).map(([kind, count]) => ({ kind, count })) }; }

app.get('/api/health', async () => ({ status: 'ok', service: 'ct-inspection-workbench', version: '0.9.0' }));
app.get('/api/scans/current', async () => scan);
app.get('/api/scans/current/slice', async (request) => { const query = request.query as { axis?: string; index?: string }; return slice(query.axis ?? 'axial', Math.max(0, Math.min(95, Number(query.index ?? 42)))); });
app.get('/api/workflow', async () => workflow);
app.get('/api/annotations', async () => annotations);

// 创建 → 写入链路：落标注 + 追加 created 事件
app.post('/api/annotations', async (request) => {
  const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'> & { idempotencyKey?: string };
  return withIdempotency(idemKeyOf(request), `create:${body.axis}:${body.index}:${body.x}:${body.y}:${body.kind}:${body.note ?? ''}`, () => {
    const item: Annotation = { ...body, id: `D-${String(annotations.length + 32).padStart(3, '0')}`, confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() };
    annotations = [item, ...annotations];
    const event = appendReviewEvent({ type: 'created', annotationId: item.id, actor: body.reviewer ?? scan.operator, detail: `${item.kind}标注于 ${item.axis} #${item.index}`, snapshot: snapshotOf(item) });
    return { ...item, events: [event] };
  });
});

// 接受 / 驳回 / 状态变更 → 备注变化先记 note_changed，再记状态事件；无变化不产生事件
app.post('/api/annotations/:id/review', async (request) => {
  const id = (request.params as { id: string }).id;
  const body = request.body as { status?: ReviewStatus; reviewer?: string; actor?: string; note?: string; idempotencyKey?: string };
  if (body.status && !VALID_STATUSES.includes(body.status)) throw httpError(400, 'invalid_status', `未知复核状态：${body.status}`);
  const item = annotations.find(annotation => annotation.id === id);
  if (!item) throw httpError(404, 'annotation_not_found', `缺陷 ${id} 不存在（可能已删除）`);
  const actor = body.actor ?? body.reviewer ?? item.reviewer ?? '王工';
  return withIdempotency(idemKeyOf(request), `review:${id}:${body.status ?? ''}:${body.note ?? ''}`, () => {
    const events: ReviewEvent[] = [];
    if (typeof body.note === 'string' && body.note !== item.note) {
      const noteBefore = item.note;
      item.note = body.note;
      events.push(appendReviewEvent({ type: 'note_changed', annotationId: id, actor, detail: '复核时更新备注', noteBefore, noteAfter: body.note, snapshot: snapshotOf(item) }));
    }
    if (body.status && body.status !== item.reviewStatus) {
      const fromStatus = item.reviewStatus;
      item.reviewStatus = body.status;
      item.reviewer = actor;
      const type: ReviewEventType = body.status === 'accepted' ? 'accepted' : body.status === 'rejected' ? 'rejected' : 'status_changed';
      events.push(appendReviewEvent({ type, annotationId: id, actor, detail: type === 'accepted' ? '缺陷被接受' : type === 'rejected' ? '缺陷被驳回' : `状态变更为 ${body.status}`, fromStatus, toStatus: body.status, snapshot: snapshotOf(item) }));
    }
    return { ...item, changed: events.length > 0, events };
  });
});

// 备注变化的独立写入链路
app.patch('/api/annotations/:id/notes', async (request) => {
  const id = (request.params as { id: string }).id;
  const body = request.body as { note?: string; actor?: string; idempotencyKey?: string };
  if (typeof body.note !== 'string' || !body.note.trim()) throw httpError(400, 'invalid_note', '备注不能为空');
  const item = annotations.find(annotation => annotation.id === id);
  if (!item) throw httpError(404, 'annotation_not_found', `缺陷 ${id} 不存在（可能已删除）`);
  const nextNote = body.note;
  return withIdempotency(idemKeyOf(request), `note:${id}:${nextNote}`, () => {
    if (nextNote === item.note) return { ...item, changed: false, events: [] };
    const noteBefore = item.note;
    item.note = nextNote;
    const event = appendReviewEvent({ type: 'note_changed', annotationId: id, actor: body.actor ?? item.reviewer ?? '王工', detail: '更新复核备注', noteBefore, noteAfter: nextNote, snapshot: snapshotOf(item) });
    return { ...item, changed: true, events: [event] };
  });
});

// 删除 → 先把删除前快照写为 deleted 事件，再移除标注；历史不受影响
app.delete('/api/annotations/:id', async (request) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { actor?: string; idempotencyKey?: string };
  return withIdempotency(idemKeyOf(request), `delete:${id}`, () => {
    const item = annotations.find(annotation => annotation.id === id);
    if (!item) {
      // 已删除再投递视为成功（幂等删除），但不产生新事件
      if (reviewHistory.some(e => e.annotationId === id && e.type === 'deleted')) return { ok: true, changed: false, events: [] };
      throw httpError(404, 'annotation_not_found', `缺陷 ${id} 不存在`);
    }
    const event = appendReviewEvent({ type: 'deleted', annotationId: id, actor: body.actor ?? scan.operator, detail: '删除前记录缺陷最终状态', snapshot: snapshotOf(item, true) });
    annotations = annotations.filter(a => a.id !== id);
    return { ok: true, changed: true, events: [event] };
  });
});

// ── 复核历史查询链路 ──
// 全量事件流：支持按缺陷 / 类型过滤、after 游标、limit；始终按发生顺序返回
app.get('/api/review-events', async (request) => {
  failIfAsked(request);
  const q = request.query as { annotationId?: string; type?: string; after?: string; limit?: string };
  if (q.type && !REVIEW_EVENT_TYPES.includes(q.type as ReviewEventType)) throw httpError(400, 'invalid_type', `未知事件类型：${q.type}`);
  try {
    return { ...selectEvents({ annotationId: q.annotationId, type: q.type as ReviewEventType | undefined, after: q.after ? Number(q.after) : undefined, limit: q.limit ? Number(q.limit) : undefined }), generatedAt: new Date().toISOString() };
  } catch (err) {
    request.log.error(err, 'review-events read failed');
    throw httpError(500, 'history_read_failed', '复核历史读取失败');
  }
});
// 单个缺陷的完整历史；缺陷已删除时仍可凭事件返回
app.get('/api/annotations/:id/history', async (request) => {
  failIfAsked(request);
  const id = (request.params as { id: string }).id;
  const exists = annotations.some(a => a.id === id) || reviewHistory.some(e => e.annotationId === id);
  if (!exists) throw httpError(404, 'history_not_found', `未找到缺陷 ${id} 或其复核历史`);
  try {
    return { annotationId: id, exists: annotations.some(a => a.id === id), ...selectEvents({ annotationId: id }), generatedAt: new Date().toISOString() };
  } catch (err) {
    request.log.error(err, 'annotation history read failed');
    throw httpError(500, 'history_read_failed', '复核历史读取失败');
  }
});

app.get('/api/measurements', async () => annotations.map(item => ({ annotationId: item.id, diameter: item.diameter, estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2), aspectRatio: +(1.1 + item.diameter * .24).toFixed(2), tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内' })));
app.get('/api/compare', async () => ({ current: { scanId: scan.id, label: 'VH-017 / 本次扫描', defectCount: annotations.length, highRisk: annotations.filter(item => item.severity === '高').length }, previous: { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 }, delta: { defectCount: annotations.length - 2, highRisk: annotations.filter(item => item.severity === '高').length } }));
app.get('/api/report', async () => ({ scan, workflow, summary: stats(), annotations, releaseGate: annotations.some(item => item.severity === '高' && item.reviewStatus !== 'accepted') ? 'blocked' : 'ready' }));
await app.listen({ port: 6182, host: '127.0.0.1' });
