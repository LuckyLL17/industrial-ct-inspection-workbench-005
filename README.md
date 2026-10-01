# 工业 CT 无损检测工作台

React + Vite + TypeScript 前端与 Fastify + TypeScript API 的全栈工业 CT 阅片、标注和复核演示项目。

## 功能
- 轴向、冠状、矢状三正交切片联动阅片
- 可调窗宽、窗位与切片序号
- 孔隙、裂纹、夹杂和未熔合缺陷标注
- API 持久于进程内的标注流、删除、汇总报告
- 缺陷尺寸、严重度、复核意见和检测摘要
- 复核历史：独立的追加式事件流，记录创建 / 接受 / 驳回 / 状态与备注变化 / 删除前事件；按发生顺序读取、支持回到对应切片、标注删除后历史仍保留

## 复核历史
- 事件只追加、不修改、不随标注删除而删除；每个事件携带当时的标注快照（轴、切片、坐标、状态、备注）。
- 顺序以全局单调 `seq` 为权威、`at` 为发生时间；`GET /api/review-events` 支持 `annotationId`、`type`、`after` 游标与 `limit`。
- 写接口（创建 / 复核 / 备注 / 删除）支持 `Idempotency-Key` 请求头（或 `idempotencyKey`），重复投递返回首结果并标记 `deduped`，不会产生重复事件；无变化的写入返回 `changed:false`。
- 早于本功能的旧数据在启动时回填 `backfill` 创建事件；读取时若仍缺事件则以 `synthetic` 临时合成（不落库）。
- `?simulateFailure=1`（或 `X-Simulate-Failure: 1`）可演练读取失败，前端历史页提供错误态与重试。

## 启动
```bash
npm install
npm run dev
```
网页：`http://localhost:5182`；API：`http://localhost:6182`。
