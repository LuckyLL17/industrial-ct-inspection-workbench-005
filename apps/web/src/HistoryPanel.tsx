import { useCallback, useEffect, useState } from 'react';

export type ReviewEvent = {
  seq: number;
  id: string;
  type: string;
  annotationId: string;
  actor: string;
  at: string;
  fromStatus?: string;
  toStatus?: string;
  fromNote?: string;
  toNote?: string;
  backfilled: boolean;
  locator: { axis: string; index: number; x: number; y: number };
  annotation: {
    id: string;
    kind: string;
    severity: string;
    note: string;
    diameter: number;
    axis: string;
    index: number;
    x: number;
    y: number;
    reviewStatus: string;
    reviewer?: string;
  };
};

export type HistoryFilter = { annotationId?: string; type?: string };

const TYPE_META: Record<string, { label: string; tone: string }> = {
  created: { label: '创建', tone: 'ev-created' },
  accepted: { label: '接受', tone: 'ev-accepted' },
  rejected: { label: '驳回', tone: 'ev-rejected' },
  status_changed: { label: '状态变更', tone: 'ev-status' },
  note_changed: { label: '备注变化', tone: 'ev-note' },
  deleted: { label: '删除', tone: 'ev-deleted' },
};

const STATUS_LABEL: Record<string, string> = {
  unreviewed: '待复核',
  in_review: '复核中',
  accepted: '已接受',
  rejected: '已驳回',
};

const AXIS_LABEL: Record<string, string> = { axial: '轴向', coronal: '冠状', sagittal: '矢状' };

const formatAt = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const describe = (event: ReviewEvent): string => {
  switch (event.type) {
    case 'created':
      return `创建${event.annotation.kind}标注（${STATUS_LABEL[event.annotation.reviewStatus] ?? event.annotation.reviewStatus}），Ø ${event.annotation.diameter} mm`;
    case 'accepted':
    case 'rejected':
    case 'status_changed':
      return `${STATUS_LABEL[event.fromStatus ?? ''] ?? event.fromStatus} → ${STATUS_LABEL[event.toStatus ?? ''] ?? event.toStatus}`;
    case 'note_changed':
      return `备注由「${event.fromNote ?? ''}」改为「${event.toNote ?? ''}」`;
    case 'deleted':
      return `删除前状态：${STATUS_LABEL[event.fromStatus ?? ''] ?? event.fromStatus ?? '未知'}，缺陷快照已保留`;
    default:
      return event.type;
  }
};

export function HistoryPanel({
  filter,
  onFilterChange,
  onLocate,
  refreshKey,
}: {
  filter: HistoryFilter;
  onFilterChange: (filter: HistoryFilter) => void;
  onLocate: (event: ReviewEvent) => void;
  refreshKey: number;
}) {
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(
    async (after = 0, append = false) => {
      setLoading(true);
      setFailed(false);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (after > 0) params.set('after', String(after));
        if (filter.annotationId) params.set('annotationId', filter.annotationId);
        if (filter.type) params.set('type', filter.type);
        const res = await fetch(`/api/history?${params}`);
        if (!res.ok) throw new Error(`history_${res.status}`);
        const data = (await res.json()) as { events: ReviewEvent[]; lastSeq: number; hasMore: boolean };
        setEvents((prev) => (append ? [...prev, ...data.events] : data.events));
        setLastSeq(data.lastSeq);
        setHasMore(data.hasMore);
      } catch {
        // 读取失败：保留已加载事件（若有），显示失败态与重试，而不是让页面崩溃
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [filter.annotationId, filter.type],
  );

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <div className="review-layout">
      <div className="review-table history-table">
        <div className="history-head">
          <div>
            <small>REVIEW HISTORY / APPEND-ONLY EVENT LOG</small>
            <h3>复核历史{filter.annotationId ? ` · ${filter.annotationId}` : ' · 全部缺陷'}</h3>
          </div>
          <div className="history-filters">
            <select
              value={filter.type ?? ''}
              onChange={(e) => onFilterChange({ ...filter, type: e.target.value || undefined })}
            >
              <option value="">全部事件</option>
              <option value="created">创建</option>
              <option value="accepted">接受</option>
              <option value="rejected">驳回</option>
              <option value="note_changed">备注变化</option>
              <option value="deleted">删除</option>
            </select>
            {filter.annotationId && (
              <button onClick={() => onFilterChange({ type: filter.type })}>查看全部缺陷</button>
            )}
            <button onClick={() => load()} className="ghost">
              刷新
            </button>
          </div>
        </div>

        {failed && (
          <div className="history-error">
            <b>历史读取失败</b>
            <span>无法从服务获取复核事件，请检查 API 后重试。已加载的事件仍保留在下方。</span>
            <button onClick={() => load()}>重试</button>
          </div>
        )}

        <ol className="timeline">
          {events.map((event) => {
            const meta = TYPE_META[event.type] ?? { label: event.type, tone: 'ev-status' };
            const deleted = event.type === 'deleted';
            return (
              <li key={event.id} className={`timeline-item ${meta.tone} ${deleted ? 'is-deleted' : ''}`}>
                <span className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-top">
                    <b>{meta.label}</b>
                    <em className="timeline-tag">{event.annotationId}</em>
                    {event.backfilled && <em className="timeline-tag backfill">旧数据补记</em>}
                    {deleted && <em className="timeline-tag deleted-tag">标注已删除</em>}
                    <time>{formatAt(event.at)}</time>
                  </div>
                  <p>{describe(event)}</p>
                  <div className="timeline-foot">
                    <span>
                      {AXIS_LABEL[event.locator.axis] ?? event.locator.axis} / Slice {event.locator.index} ·
                      操作人 {event.actor} · #{event.seq}
                    </span>
                    <button
                      onClick={() => onLocate(event)}
                      title="跳转到该事件发生时的切片位置"
                    >
                      定位切片 →
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
          {!loading && !failed && events.length === 0 && (
            <li className="timeline-empty">没有匹配的复核事件</li>
          )}
          {loading && <li className="timeline-empty">加载中…</li>}
        </ol>

        {hasMore && (
          <button className="history-more" onClick={() => load(lastSeq, true)}>
            加载更早的事件
          </button>
        )}
      </div>

      <div className="measurement-card history-legend">
        <small>EVENT SOURCES</small>
        <h3>事件来源与保证</h3>
        <p>创建、接受、驳回、备注变化与删除前状态均在命令处理时即时追加；事件只增不改，按发生顺序读取。</p>
        <ul>
          <li><i className="ev-created-dot" /> 创建：初检标注落库</li>
          <li><i className="ev-accepted-dot" /> 接受 / 驳回：复核结论</li>
          <li><i className="ev-note-dot" /> 备注变化：复核意见留痕</li>
          <li><i className="ev-deleted-dot" /> 删除：保留删除前快照与定位</li>
        </ul>
        <p className="muted">重复请求携带同一 Idempotency-Key 不会产生重复事件；标注删除后其历史仍可查看。标记“旧数据补记”的事件来自功能上线前的标注迁移。</p>
      </div>
    </div>
  );
}
