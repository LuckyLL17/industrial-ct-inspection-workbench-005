# 工业 CT 无损检测工作台

React + Vite + TypeScript 前端与 Fastify + TypeScript API 的全栈工业 CT 阅片、标注和复核演示项目。

## 功能
- 轴向、冠状、矢状三正交切片联动阅片
- 可调窗宽、窗位与切片序号
- 孔隙、裂纹、夹杂和未熔合缺陷标注
- API 持久于进程内的标注流、删除、汇总报告
- 缺陷尺寸、严重度、复核意见和检测摘要
- 复核历史（追加式事件流）：记录创建、接受、驳回、备注变化与删除前事件，
  按发生顺序读取，事件可跳转回对应切片与缺陷，标注删除后历史仍可查看

## 复核历史
- 事件类型：`created` / `accepted` / `rejected` / `status_changed` /
  `note_changed` / `deleted`，每个事件带单调序号 `seq`、切片定位
  （`axis/index/x/y`）和事件发生时的完整标注快照。
- 写入链路在创建、复核、备注、删除命令处理时即时追加，事件只增不改。
- 重复投递：写接口读取 `Idempotency-Key` 请求头，同一键的重复请求返回
  首次响应，不产生重复事件；状态/备注未变化也不产生事件。
- 旧数据：服务启动时为功能上线前已存在的标注按 `createdAt` 回填一条
  `backfilled` 的创建事件，迁移前不可恢复的复核动作以标记区分。
- 查询：`GET /api/history`（支持 `annotationId` / `type` / `after` /
  `limit`）与 `GET /api/annotations/:id/history`；读取失败返回 5xx 结构化
  错误，前端展示失败态并可重试。
- 已删除标注再写操作返回 `410`，其历史仍可正常查询；未知缺陷返回 `404`。

## 启动
```bash
npm install
npm run dev
```
网页：`http://localhost:5182`；API：`http://localhost:6182`。
