import { randomUUID } from 'node:crypto';

/**
 * 复核历史：独立于标注当前状态的追加式事件存储（append-only event log）。
 *
 * 为什么不“从当前标注反推历史”：当前表只保留最新状态，无法还原接受/驳回的
 * 多次翻转与备注变化，标注删除后审计链也随之消失。事件流只追加、不修改、
 * 不删除；每个事件带当时的完整标注快照与切片定位，因此即使标注被删除，
 * 仍可从事件回到缺陷与切片。
 */

export type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';

export type ReviewEventType =
  | 'created'
  | 'accepted'
  | 'rejected'
  | 'status_changed'
  | 'note_changed'
  | 'deleted';

export interface Annotation {
  id: string;
  axis: string;
  index: number;
  x: number;
  y: number;
  kind: string;
  severity: string;
  note: string;
  diameter: number;
  confidence: number;
  reviewStatus: ReviewStatus;
  reviewer?: string;
  createdAt: string;
}

export interface SliceLocator {
  axis: string;
  index: number;
  x: number;
  y: number;
}

export interface ReviewEvent {
  /** 全局单调递增序号，历史按发生顺序读取的依据 */
  seq: number;
  id: string;
  /** 事件自身的去重键（每次写入生成 UUID） */
  eventKey: string;
  type: ReviewEventType;
  annotationId: string;
  actor: string;
  at: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  fromNote?: string;
  toNote?: string;
  /** 旧数据迁移事件：仅能补记“创建”，迁移前的复核动作不可恢复 */
  backfilled: boolean;
  /** 切片定位，事件可直接跳回对应三视图位置 */
  locator: SliceLocator;
  /** 事件发生时的标注完整快照，删除后仍可查看缺陷信息 */
  annotation: Annotation;
}

export interface AppendInput {
  type: ReviewEventType;
  annotation: Annotation;
  actor?: string;
  at?: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  fromNote?: string;
  toNote?: string;
  backfilled?: boolean;
}

export interface ListOptions {
  annotationId?: string;
  type?: ReviewEventType;
  /** 游标：只返回 seq 大于该值的事件 */
  after?: number;
  limit?: number;
}

let events: ReviewEvent[] = [];
let seq = 0;

/** 请求级幂等表：Idempotency-Key -> 首次请求的响应体 */
const keyedResults = new Map<string, unknown>();

/** 已删除标注的最终快照注册表，用于区分“从未存在”与“已删除” */
const removedAnnotations = new Map<string, Annotation>();

export function snapshot(annotation: Annotation): Annotation {
  return { ...annotation };
}

export function locatorOf(annotation: Annotation): SliceLocator {
  return { axis: annotation.axis, index: annotation.index, x: annotation.x, y: annotation.y };
}

export function appendEvent(input: AppendInput): ReviewEvent {
  seq += 1;
  const event: ReviewEvent = {
    seq,
    id: `EV-${String(seq).padStart(6, '0')}`,
    eventKey: randomUUID(),
    type: input.type,
    annotationId: input.annotation.id,
    actor: input.actor ?? '系统',
    at: input.at ?? new Date().toISOString(),
    backfilled: input.backfilled ?? false,
    locator: locatorOf(input.annotation),
    annotation: snapshot(input.annotation),
  };
  if (input.fromStatus !== undefined) event.fromStatus = input.fromStatus;
  if (input.toStatus !== undefined) event.toStatus = input.toStatus;
  if (input.fromNote !== undefined) event.fromNote = input.fromNote;
  if (input.toNote !== undefined) event.toNote = input.toNote;
  events.push(event);
  return event;
}

/**
 * 请求级幂等：同一 Idempotency-Key 的重复请求（网络重试、用户重复点击）
 * 直接返回首次响应，不再追加任何事件。Node 单线程、处理器内无异步断点，
 * “先查后写”不存在竞态。
 */
export function replayKeyed(key: string | undefined): unknown | undefined {
  return key ? keyedResults.get(key) : undefined;
}

export function rememberKeyed(key: string | undefined, result: unknown): void {
  if (key) keyedResults.set(key, result);
}

export function listHistory(options: ListOptions = {}): {
  events: ReviewEvent[];
  lastSeq: number;
  hasMore: boolean;
} {
  const after = options.after ?? 0;
  const rows = events
    .filter(
      (event) =>
        event.seq > after &&
        (!options.annotationId || event.annotationId === options.annotationId) &&
        (!options.type || event.type === options.type),
    )
    .sort((a, b) => a.seq - b.seq);
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const page = rows.slice(0, limit);
  return {
    events: page,
    lastSeq: page.length > 0 ? page[page.length - 1].seq : after,
    hasMore: rows.length > page.length,
  };
}

export function eventsFor(annotationId: string): ReviewEvent[] {
  return events
    .filter((event) => event.annotationId === annotationId)
    .sort((a, b) => a.seq - b.seq);
}

export function markDeleted(annotation: Annotation): void {
  removedAnnotations.set(annotation.id, snapshot(annotation));
}

export function removedAnnotation(id: string): Annotation | undefined {
  return removedAnnotations.get(id);
}

/**
 * 旧数据迁移：功能上线前已存在的标注没有历史，只能依据 createdAt 补记一条
 * backfilled 的 created 事件，保证时间线上它们排在运行时事件之前。迁移前
 * 发生过的接受/驳回不可恢复，事件上显式标记以免误认为完整审计链。
 */
export function backfillCreated(annotations: Annotation[]): void {
  if (events.length > 0) return;
  [...annotations]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .forEach((annotation) => {
      appendEvent({
        type: 'created',
        annotation: snapshot(annotation),
        actor: '系统迁移',
        at: annotation.createdAt,
        backfilled: true,
      });
    });
}
