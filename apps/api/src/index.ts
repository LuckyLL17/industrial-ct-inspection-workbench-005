import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  appendEvent,
  backfillCreated,
  eventsFor,
  listHistory,
  locatorOf,
  markDeleted,
  rememberKeyed,
  replayKeyed,
  removedAnnotation,
  snapshot,
  type Annotation,
  type ReviewEventType,
  type ReviewStatus,
} from './history.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const scan = { id: 'valve-housing-017', part: '液压阀体 / VH-017', material: 'AlSi10Mg', resolution: '42 μm', dimensions: '128 × 128 × 96 voxels', operator: '张工', acquiredAt: '2026-09-30 08:42', scanner: 'Phoenix v|tome|x M 300', lot: 'LOT-2026-09-A17', standard: 'ASTM E1441' };
let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];
// 旧数据没有历史：启动时按 createdAt 回填带 backfilled 标记的 created 事件
backfillCreated(annotations);

const workflow = [
  { id: 'ingest', label: '数据接收', status: 'done', owner: '系统', detail: '原始 DICOM 序列已校验' },
  { id: 'reconstruct', label: '体数据重建', status: 'done', owner: '算法服务', detail: '96 层切片已生成' },
  { id: 'primary', label: '初检标注', status: 'active', owner: '张工', detail: '存在 3 个候选缺陷' },
  { id: 'review', label: '二次复核', status: 'pending', owner: '王工', detail: '等待高风险裂纹复核' },
  { id: 'release', label: '报告签发', status: 'pending', owner: '质量负责人', detail: '需完成复核与判定' }
];

const STATUS_VALUES: ReviewStatus[] = ['unreviewed', 'in_review', 'accepted', 'rejected'];
const idempotencyKey = (request: { headers: Record<string, unknown> }): string | undefined => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};
const error = (reply: FastifyReply, status: number, code: string, detail?: string) =>
  reply.code(status).send({ ok: false, error: code, ...(detail ? { detail } : {}) });

function slice(axis: string, index: number) { const size = 96; const data: number[][] = []; for (let y = 0; y < size; y++) { const row: number[] = []; for (let x = 0; x < size; x++) { const dx = x - 48, dy = y - 48; const shell = Math.sqrt(dx * dx + dy * dy); let value = 12 + Math.max(0, 1 - Math.abs(shell - 31) / 9) * 130 + Math.max(0, 1 - Math.abs(shell - 14) / 5) * 48; value += 16 * Math.sin((x + index) * .17) * Math.cos((y - index) * .12); const hole = (x - (57 + Math.sin(index * .15) * 4)) ** 2 + (y - (39 + Math.cos(index * .1) * 3)) ** 2; if (hole < 28 + (index - 42) ** 2 * .7) value = 8; const inclusion = (x - 30) ** 2 + (y - 61) ** 2; if (inclusion < 13 && axis !== 'sagittal') value = 220; row.push(Math.max(0, Math.min(255, Math.round(value)))); } data.push(row); } return { axis, index, size, data }; }
function stats() { return { defectCount: annotations.length, criticalCount: annotations.filter(item => item.severity === '高').length, unreviewedCount: annotations.filter(item => item.reviewStatus !== 'accepted' && item.reviewStatus !== 'rejected').length, totalVolume: +annotations.reduce((sum, item) => sum + 4 / 3 * Math.PI * (item.diameter / 2) ** 3, 0).toFixed(2), byKind: Object.entries(annotations.reduce<Record<string, number>>((out, item) => { out[item.kind] = (out[item.kind] ?? 0) + 1; return out; }, {})).map(([kind, count]) => ({ kind, count })) }; }

app.get('/api/health', async () => ({ status: 'ok', service: 'ct-inspection-workbench', version: '0.9.0' }));
app.get('/api/scans/current', async () => scan);
app.get('/api/scans/current/slice', async (request) => { const query = request.query as { axis?: string; index?: string }; return slice(query.axis ?? 'axial', Math.max(0, Math.min(95, Number(query.index ?? 42)))); });
app.get('/api/workflow', async () => workflow);
app.get('/api/annotations', async () => annotations);

// —— 写入链路：每个命令在修改当前状态的同时追加复核事件 ——

app.post('/api/annotations', async (request, reply) => {
  const key = idempotencyKey(request);
  const cached = replayKeyed(key);
  if (cached) return cached;
  const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'>;
  const item: Annotation = { ...body, id: `D-${String(annotations.length + 32).padStart(3, '0')}`, confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() };
  annotations = [item, ...annotations];
  const event = appendEvent({ type: 'created', annotation: snapshot(item), actor: '张工' });
  const result = { ...item, event: { seq: event.seq, id: event.id, type: event.type } };
  rememberKeyed(key, result);
  return result;
});

app.post('/api/annotations/:id/review', async (request, reply) => {
  const key = idempotencyKey(request);
  const cached = replayKeyed(key);
  if (cached) return cached;
  const id = (request.params as { id: string }).id;
  const body = request.body as { status?: ReviewStatus; reviewer?: string; note?: string };
  if (!body.status || !STATUS_VALUES.includes(body.status)) return error(reply, 400, 'invalid_status', `status 必须为 ${STATUS_VALUES.join(' / ')}`);
  const item = annotations.find(annotation => annotation.id === id);
  if (!item) {
    const removed = removedAnnotation(id);
    return removed
      ? error(reply, 410, 'annotation_deleted', '该缺陷已被删除，历史仍可通过 /api/history 查询')
      : error(reply, 404, 'annotation_not_found');
  }
  const before = snapshot(item);
  item.reviewStatus = body.status;
  item.reviewer = body.reviewer ?? item.reviewer ?? '王工';
  if (body.note && body.note !== item.note) item.note = body.note;
  // 接受/驳回各自成事件；其它状态流转（如退回待复核）记 status_changed；状态未变不产生事件
  const type: ReviewEventType =
    body.status === 'accepted' || body.status === 'rejected' ? body.status : 'status_changed';
  const event = before.reviewStatus !== item.reviewStatus
    ? appendEvent({
        type,
        annotation: snapshot(item),
        actor: item.reviewer,
        fromStatus: before.reviewStatus,
        toStatus: item.reviewStatus,
      })
    : undefined;
  const result = { ...item, event: event ? { seq: event.seq, id: event.id, type: event.type } : null };
  rememberKeyed(key, result);
  return result;
});

// 备注独立修改入口：复核意见的变化是质量追溯要求记录的关键事件
app.post('/api/annotations/:id/note', async (request, reply) => {
  const key = idempotencyKey(request);
  const cached = replayKeyed(key);
  if (cached) return cached;
  const id = (request.params as { id: string }).id;
  const body = request.body as { note?: string; reviewer?: string };
  if (typeof body.note !== 'string') return error(reply, 400, 'invalid_note', 'note 必须为字符串');
  const item = annotations.find(annotation => annotation.id === id);
  if (!item) {
    const removed = removedAnnotation(id);
    return removed
      ? error(reply, 410, 'annotation_deleted', '该缺陷已被删除，无法修改备注；历史仍可查询')
      : error(reply, 404, 'annotation_not_found');
  }
  const before = snapshot(item);
  if (body.note === before.note) {
    const unchanged = { ...item, event: null };
    rememberKeyed(key, unchanged);
    return unchanged;
  }
  item.note = body.note;
  if (body.reviewer) item.reviewer = body.reviewer;
  const event = appendEvent({
    type: 'note_changed',
    annotation: snapshot(item),
    actor: body.reviewer ?? item.reviewer ?? '张工',
    fromNote: before.note,
    toNote: item.note,
  });
  const result = { ...item, event: { seq: event.seq, id: event.id, type: event.type } };
  rememberKeyed(key, result);
  return result;
});

app.delete('/api/annotations/:id', async (request, reply) => {
  const key = idempotencyKey(request);
  const cached = replayKeyed(key);
  if (cached) return cached;
  const id = (request.params as { id: string }).id;
  const item = annotations.find(annotation => annotation.id === id);
  // 删除本身幂等：第二次删除同一缺陷不再产生 deleted 事件
  if (!item) {
    const removed = removedAnnotation(id);
    const result = { ok: true as const, id, deleted: false, alreadyDeleted: Boolean(removed), event: null };
    rememberKeyed(key, result);
    return result;
  }
  const event = appendEvent({ type: 'deleted', annotation: snapshot(item), actor: '张工', fromStatus: item.reviewStatus });
  annotations = annotations.filter(annotation => annotation.id !== id);
  markDeleted(item);
  const result = { ok: true as const, id, deleted: true, event: { seq: event.seq, id: event.id, type: event.type } };
  rememberKeyed(key, result);
  return result;
});

// —— 查询链路：历史按 seq 升序（发生顺序）读取，删除后依然可查 ——

app.get('/api/annotations/:id/history', async (request, reply) => {
  try {
    const id = (request.params as { id: string }).id;
    const exists = annotations.some(annotation => annotation.id === id) || Boolean(removedAnnotation(id));
    if (!exists) return error(reply, 404, 'annotation_not_found', '缺陷不存在，且没有任何历史记录');
    const rows = eventsFor(id);
    return {
      annotationId: id,
      deleted: !annotations.some(annotation => annotation.id === id),
      events: rows,
      lastSeq: rows.length ? rows[rows.length - 1].seq : 0,
    };
  } catch (err) {
    request.log.error(err);
    return error(reply, 500, 'history_read_failed', '复核历史读取失败，请稍后重试');
  }
});

app.get('/api/history', async (request, reply) => {
  try {
    const query = request.query as { annotationId?: string; type?: ReviewEventType; after?: string; limit?: string };
    const after = query.after !== undefined ? Number(query.after) : undefined;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;
    if ((after !== undefined && !Number.isFinite(after)) || (limit !== undefined && !Number.isFinite(limit))) {
      return error(reply, 400, 'invalid_cursor', 'after / limit 必须为数字');
    }
    const result = listHistory({
      annotationId: query.annotationId,
      type: query.type,
      after,
      limit,
    });
    return { ...result, filter: { annotationId: query.annotationId, type: query.type } };
  } catch (err) {
    request.log.error(err);
    return error(reply, 500, 'history_read_failed', '复核历史读取失败，请稍后重试');
  }
});

app.get('/api/measurements', async () => annotations.map(item => ({ annotationId: item.id, diameter: item.diameter, estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2), aspectRatio: +(1.1 + item.diameter * .24).toFixed(2), tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内' })));
app.get('/api/compare', async () => ({ current: { scanId: scan.id, label: 'VH-017 / 本次扫描', defectCount: annotations.length, highRisk: annotations.filter(item => item.severity === '高').length }, previous: { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 }, delta: { defectCount: annotations.length - 2, highRisk: annotations.filter(item => item.severity === '高').length } }));
app.get('/api/report', async () => ({ scan, workflow, summary: stats(), annotations, releaseGate: annotations.some(item => item.severity === '高' && item.reviewStatus !== 'accepted') ? 'blocked' : 'ready' }));

// 事件本身携带定位信息；保留定位端点以便前端从历史事件统一跳转
app.get('/api/annotations/:id/locator', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const item = annotations.find(annotation => annotation.id === id) ?? removedAnnotation(id);
  if (!item) return error(reply, 404, 'annotation_not_found');
  return { annotationId: id, deleted: !annotations.some(annotation => annotation.id === id), locator: locatorOf(item) };
});

await app.listen({ port: 6182, host: '127.0.0.1' });
