import { useEffect, useRef, useState } from 'react';
import { HistoryPanel, type HistoryFilter, type ReviewEvent } from './HistoryPanel';

type Axis = 'axial' | 'coronal' | 'sagittal';
type Slice = { axis: string; index: number; size: number; data: number[][] };
type Annotation = {
  id: string; axis: string; index: number; x: number; y: number;
  kind: string; severity: string; note: string; diameter: number; confidence: number;
  reviewStatus: string; reviewer?: string;
};
type LocatorMark = { id: string; axis: string; index: number; x: number; y: number; severity: string; deleted: boolean };

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...init }).then(r => r.json());

/** 每次交互生成独立幂等键：重复投递（重试/双击）不会产生重复事件 */
const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function mutate(path: string, method: 'POST' | 'DELETE', body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `http_${res.status}`);
  return data as { event?: { seq: number; id: string; type: string } | null };
}

const STATUS_LABEL: Record<string, string> = {
  unreviewed: '待复核', in_review: '复核中', accepted: '已接受', rejected: '已驳回',
};

function SliceView({
  axis, index, onIndex, annotations, onMark, locate,
}: {
  axis: Axis; index: number; onIndex: (n: number) => void;
  annotations: Annotation[]; onMark: (axis: Axis, x: number, y: number) => void;
  locate: LocatorMark | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [slice, setSlice] = useState<Slice | null>(null);
  const [window, setWindow] = useState(210);
  const [level, setLevel] = useState(108);
  useEffect(() => { api(`/scans/current/slice?axis=${axis}&index=${index}`).then(setSlice) }, [axis, index]);
  useEffect(() => {
    if (!slice || !canvas.current) return;
    const ctx = canvas.current.getContext('2d')!;
    const img = ctx.createImageData(slice.size, slice.size);
    slice.data.flat().forEach((raw, i) => {
      const v = Math.max(0, Math.min(255, ((raw - (level - window / 2)) / window) * 255));
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    });
    ctx.putImageData(img, 0, 0);
  }, [slice, window, level]);
  const marks = annotations.filter(a => a.axis === axis && Math.abs(a.index - index) < 3);
  const located = locate && locate.axis === axis ? locate : null;
  return <div className="view">
    <div className="view-head"><b>{axis === 'axial' ? '轴向 Axial' : axis === 'coronal' ? '冠状 Coronal' : '矢状 Sagittal'}</b><span>Slice {index} / 95</span></div>
    <div className="image-wrap" onClick={e => {
      const r = e.currentTarget.getBoundingClientRect();
      onMark(axis, (e.clientX - r.left) / r.width * 96, (e.clientY - r.top) / r.height * 96);
    }}>
      <canvas ref={canvas} width="96" height="96" />
      {marks.map(a => <div className={`mark ${a.severity} ${a.reviewStatus}`} key={a.id}
        style={{ left: `${a.x / 96 * 100}%`, top: `${a.y / 96 * 100}%` }}><i /><span>{a.id}</span></div>)}
      {located && <div className={`mark located ${located.severity} ${located.deleted ? 'gone' : ''}`}
        style={{ left: `${located.x / 96 * 100}%`, top: `${located.y / 96 * 100}%` }}>
        <i /><span>{located.id}{located.deleted ? '（已删除）' : ''}</span></div>}
      <div className="cross v" /><div className="cross h" />
    </div>
    <input type="range" min="0" max="95" value={index} onChange={e => onIndex(+e.target.value)} />
    <div className="window">
      <label>窗宽 {window}<input type="range" min="80" max="255" value={window} onChange={e => setWindow(+e.target.value)} /></label>
      <label>窗位 {level}<input type="range" min="30" max="210" value={level} onChange={e => setLevel(+e.target.value)} /></label>
    </div>
  </div>;
}

function ReviewRow({
  a, onReview, onNote, onHistory,
}: {
  a: Annotation;
  onReview: (id: string, status: 'accepted' | 'rejected') => void;
  onNote: (id: string, note: string) => void;
  onHistory: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.note);
  const [saving, setSaving] = useState(false);
  return <div className="review-row">
    <span className={`severity ${a.severity}`} />
    <div>
      <b>{a.id} · {a.kind} · {a.diameter} mm</b>
      <small>{a.axis} / Slice {a.index} · 置信度 {Math.round(a.confidence * 100)}% · {a.note}</small>
      {editing && <div className="note-edit">
        <input value={draft} onChange={e => setDraft(e.target.value)} />
        <button disabled={saving} onClick={async () => { setSaving(true); try { await onNote(a.id, draft); setEditing(false); } finally { setSaving(false); } }}>保存</button>
        <button className="ghost" onClick={() => { setDraft(a.note); setEditing(false); }}>取消</button>
      </div>}
    </div>
    <strong>{STATUS_LABEL[a.reviewStatus] ?? a.reviewStatus}</strong>
    <button onClick={() => onReview(a.id, 'accepted')}>接受</button>
    <button onClick={() => onReview(a.id, 'rejected')}>驳回</button>
    <button className="ghost" onClick={() => { setDraft(a.note); setEditing(v => !v); }}>备注</button>
    <button className="ghost" onClick={() => onHistory(a.id)} title="查看该缺陷的复核历史">历史</button>
  </div>;
}

export default function App() {
  const [scan, setScan] = useState<any>();
  const [anns, setAnns] = useState<Annotation[]>([]);
  const [workflow, setWorkflow] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>();
  const [compare, setCompare] = useState<any>();
  const [measurements, setMeasurements] = useState<any[]>([]);
  const [indices, setIndices] = useState<Record<Axis, number>>({ axial: 42, coronal: 37, sagittal: 51 });
  const [kind, setKind] = useState('孔隙');
  const [severity, setSeverity] = useState('中');
  const [note, setNote] = useState('待复核缺陷');
  const [tab, setTab] = useState<'viewer' | 'review' | 'release' | 'history'>('viewer');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>({});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [locate, setLocate] = useState<LocatorMark | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => Promise.all([api('/annotations'), api('/workflow'), api('/report'), api('/measurements'), api('/compare')])
    .then(([a, w, r, m, c]) => { setAnns(a); setWorkflow(w); setSummary(r.summary); setMeasurements(m); setCompare(c); setError(null); })
    .catch(() => setError('数据加载失败，请确认 API 服务已启动后重试'));
  useEffect(() => { api('/scans/current').then(setScan); load(); }, []);

  const afterMutation = async () => { await load(); setHistoryRefresh(k => k + 1); };
  const fail = (prefix: string) => (err: unknown) =>
    setError(`${prefix}：${err instanceof Error ? err.message : '未知错误'}（事件未生成或网络失败，可重试同一操作）`);

  const mark = async (axis: Axis, x: number, y: number) => {
    try {
      await mutate('/annotations', 'POST', {
        axis, index: indices[axis], x: +x.toFixed(1), y: +y.toFixed(1),
        kind, severity, note, diameter: +(0.5 + Math.random() * 2.2).toFixed(2),
      });
      setLocate(null);
      await afterMutation();
    } catch (err) { fail('标注创建失败')(err); }
  };
  const review = async (id: string, status: 'accepted' | 'rejected') => {
    try { await mutate(`/annotations/${id}/review`, 'POST', { status, reviewer: '王工' }); await afterMutation(); }
    catch (err) { fail('复核操作失败')(err); }
  };
  const saveNote = async (id: string, next: string) => {
    try { await mutate(`/annotations/${id}/note`, 'POST', { note: next, reviewer: '王工' }); await afterMutation(); }
    catch (err) { fail('备注保存失败')(err); throw err; }
  };
  const remove = async (id: string) => {
    try { await mutate(`/annotations/${id}`, 'DELETE'); await afterMutation(); }
    catch (err) { fail('删除失败')(err); }
  };

  const openHistory = (annotationId?: string) => { setHistoryFilter(annotationId ? { annotationId } : {}); setTab('history'); setHistoryRefresh(k => k + 1); };
  const locateEvent = (event: ReviewEvent) => {
    const l = event.locator;
    setIndices(s => ({ ...s, [l.axis]: l.index }));
    // 即使标注已删除，也依据事件快照与定位回到切片位置
    setLocate({ id: event.annotationId, axis: l.axis, index: l.index, x: l.x, y: l.y, severity: event.annotation.severity, deleted: event.type === 'deleted' });
    setTab('viewer');
  };

  return <div className="app">
    <header>
      <div className="brand">
        <div className="mark-logo">◉</div>
        <div><small>INDUSTRIAL CT / DIGITAL QUALITY WORKSPACE</small><h1>CT Inspect <i>·</i> 无损检测阅片与复核</h1></div>
      </div>
      <div className="status">
        <span>工作流 {summary?.unreviewedCount ? `待处理 ${summary.unreviewedCount}` : '已清空'}</span>
        <b>{scan?.part}</b>
        <button onClick={() => openHistory()}>复核历史</button>
        <button onClick={() => setTab('release')}>签发检查</button>
      </div>
    </header>
    {error && <div className="error-banner" onClick={() => setError(null)}>{error}（点击关闭）</div>}
    <main>
      <section className="viewer">
        <div className="viewer-head">
          <div><small>MULTIPLANAR RECONSTRUCTION / DEFECT REVIEW</small><h2>{scan?.part ?? '加载扫描…'}</h2></div>
          <div className="specs"><span>{scan?.material}</span><span>{scan?.resolution}</span><span>{scan?.scanner}</span></div>
        </div>
        <nav className="tabs">
          <button className={tab === 'viewer' ? 'active' : ''} onClick={() => setTab('viewer')}>三视图阅片</button>
          <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>缺陷复核</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => openHistory()}>复核历史</button>
          <button className={tab === 'release' ? 'active' : ''} onClick={() => setTab('release')}>质量签发</button>
        </nav>

        {tab === 'viewer' && <>
          <div className="views">
            <SliceView axis="axial" index={indices.axial} onIndex={n => { setIndices(s => ({ ...s, axial: n })); setLocate(null); }} annotations={anns} onMark={mark} locate={locate} />
            <SliceView axis="coronal" index={indices.coronal} onIndex={n => { setIndices(s => ({ ...s, coronal: n })); setLocate(null); }} annotations={anns} onMark={mark} locate={locate} />
            <SliceView axis="sagittal" index={indices.sagittal} onIndex={n => { setIndices(s => ({ ...s, sagittal: n })); setLocate(null); }} annotations={anns} onMark={mark} locate={locate} />
          </div>
          <div className="help">
            <span>点击切片创建当前类型标注（自动记录创建事件）</span>
            <span>支持窗宽、窗位与多视图切片联动</span>
            <span>{scan?.standard} · {scan?.lot}</span>
          </div>
        </>}

        {tab === 'review' && <div className="review-layout">
          <div className="review-table">
            <div className="history-head">
              <small>REVIEW QUEUE</small>
              <button className="ghost" onClick={() => openHistory()}>查看全部复核历史</button>
            </div>
            <h3>缺陷复核队列</h3>
            {anns.map(a => <ReviewRow key={a.id} a={a} onReview={review} onNote={saveNote} onHistory={openHistory} />)}
          </div>
          <div className="measurement-card">
            <small>MEASUREMENT PIPELINE</small>
            <h3>缺陷尺寸与工艺阈值</h3>
            {measurements.map(m => <div className="measurement" key={m.annotationId}>
              <span>{m.annotationId}</span><b>Ø {m.diameter} mm / {m.estimatedVolume} mm³</b><em>{m.tolerance}</em>
            </div>)}
          </div>
        </div>}

        {tab === 'history' && <HistoryPanel filter={historyFilter} onFilterChange={setHistoryFilter} onLocate={locateEvent} refreshKey={historyRefresh} />}

        {tab === 'release' && <div className="release">
          <div className="release-card">
            <small>INSPECTION WORKFLOW</small>
            <h3>检测流程门禁</h3>
            {workflow.map(step => <div className="workflow" key={step.id}>
              <span className={step.status} />
              <div><b>{step.label}</b><small>{step.owner} · {step.detail}</small></div>
              <em>{step.status === 'done' ? '已完成' : step.status === 'active' ? '进行中' : '待处理'}</em>
            </div>)}
            <div className={`release-gate ${summary?.criticalCount && summary?.unreviewedCount ? 'blocked' : 'ready'}`}>
              {summary?.criticalCount && summary?.unreviewedCount ? '阻断：高风险缺陷尚未完成复核' : '可签发：当前检测门禁满足'}
            </div>
          </div>
          <div className="release-card">
            <small>BATCH COMPARISON</small>
            <h3>与上一炉次对比</h3>
            <div className="batch-compare">
              <div><span>当前批次</span><b>{compare?.current?.defectCount} 个缺陷 / {compare?.current?.highRisk} 高风险</b></div>
              <div><span>上一炉次</span><b>{compare?.previous?.defectCount} 个缺陷 / {compare?.previous?.highRisk} 高风险</b></div>
              <div><span>变化</span><b className={compare?.delta?.defectCount > 0 ? 'warn' : ''}>{compare?.delta?.defectCount > 0 ? '+' : ''}{compare?.delta?.defectCount} 个</b></div>
            </div>
            <button className="release-button" onClick={() => alert('已生成检测报告草稿，待质量负责人电子签名')}>生成报告草稿</button>
          </div>
        </div>}
      </section>

      <aside>
        <section className="panel">
          <small>ANNOTATION TOOL</small>
          <h3>缺陷标注参数</h3>
          <label>缺陷类别<select value={kind} onChange={e => setKind(e.target.value)}><option>孔隙</option><option>裂纹</option><option>夹杂</option><option>未熔合</option></select></label>
          <label>严重度<select value={severity} onChange={e => setSeverity(e.target.value)}><option>低</option><option>中</option><option>高</option></select></label>
          <label>复核意见<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
          <p>设置参数后，在三视图任意位置点击，系统会创建带坐标、切片、置信度和复核状态的缺陷实体，并在复核历史中追加创建事件。</p>
        </section>
        <section className="panel">
          <div className="title-row">
            <div><small>DEFECT LAYERS</small><h3>缺陷图层</h3></div><b>{anns.length}</b>
          </div>
          <div className="defects">
            {anns.map(a => <div className="defect" key={a.id}>
              <span className={`severity ${a.severity}`} />
              <div>
                <b>{a.id} · {a.kind}</b>
                <small>{a.axis} / Slice {a.index} · Ø {a.diameter} mm · {STATUS_LABEL[a.reviewStatus] ?? a.reviewStatus}</small>
                <em>{a.note}</em>
              </div>
              <button onClick={() => openHistory(a.id)} title="复核历史">历</button>
              <button onClick={() => remove(a.id)} title="删除">×</button>
            </div>)}
          </div>
        </section>
        <section className="panel summary">
          <small>INSPECTION SUMMARY</small>
          <div><span>扫描操作员</span><b>{scan?.operator ?? '—'}</b></div>
          <div><span>缺陷总数 / 高风险</span><b>{summary?.defectCount ?? '—'} / {summary?.criticalCount ?? '—'}</b></div>
          <div><span>总体积</span><b>{summary?.totalVolume ?? '—'} mm³</b></div>
          <div><span>批次</span><b>{scan?.lot ?? '—'}</b></div>
        </section>
      </aside>
    </main>
  </div>;
}
