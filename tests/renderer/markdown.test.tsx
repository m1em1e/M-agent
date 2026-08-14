import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../../src/renderer/markdown";

describe("MarkdownContent", () => {
  it("渲染段落与加粗", () => {
    const html = renderToStaticMarkup(<MarkdownContent text="**重要**文本" />);
    expect(html).toContain("<strong>重要</strong>");
  });

  it("渲染 GFM 表格", () => {
    const text = "| 列1 | 列2 |\n| --- | --- |\n| a | b |";
    const html = renderToStaticMarkup(<MarkdownContent text={text} />);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>列1</th>");
    expect(html).toContain("<td>b</td>");
  });

  it("渲染代码块、列表与删除线", () => {
    const text = "```ts\nconst a = 1\n```\n\n- item1\n- item2\n\n~~废弃~~";
    const html = renderToStaticMarkup(<MarkdownContent text={text} />);
    expect(html).toContain("language-ts");
    expect(html).toContain("<li>item1</li>");
    expect(html).toContain("<del>废弃</del>");
  });

  it("不渲染原始 HTML（防 XSS）", () => {
    const html = renderToStaticMarkup(<MarkdownContent text="<script>alert(1)</script>" />);
    expect(html).not.toContain("<script");
  });

  it("过滤危险链接协议", () => {
    const html = renderToStaticMarkup(<MarkdownContent text="[bad](javascript:alert(1))" />);
    expect(html).not.toContain("javascript:");
  });
});
