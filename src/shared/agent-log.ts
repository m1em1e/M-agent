/**
 * Agent 调试日志事件契约。
 * core 只依赖该接口（回调透出），不接触文件系统；文件写入由 main 进程实现。
 */

/** 一条可序列化的日志事件（会被写入 JSON-lines）。 */
export type AgentLogEvent = Record<string, unknown>;

/** 事件接收器。core 在关键节点调用，由 main 进程写入 dev 日志文件。 */
export type AgentLogSink = (event: AgentLogEvent) => void;
