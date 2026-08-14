import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent 回复的 Markdown 渲染。
 * 由 react-markdown + remark-gfm 处理：安全（不使用 dangerouslySetInnerHTML、
 * 默认剥离原始 HTML、urlTransform 过滤危险协议），原生支持 GFM 表格/删除线/任务列表。
 */
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
