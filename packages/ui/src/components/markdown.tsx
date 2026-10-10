import type { ReactNode } from "react";
import { shortUrl } from "../lib/url";
import { cn } from "../lib/cn";
import { CopyButton } from "./copy-button";

export type MarkdownListItem = {
  text: string;
  /** `- [ ]` / `- [x]` task items; null for an ordinary item. */
  checked: boolean | null;
  children: MarkdownBlock[];
};

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const SAFE_LINK = /^(https?:|mailto:|\/(?!\/))/i;

function indentOf(whitespace: string): number {
  return whitespace.replace(/\t/g, "    ").length;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s{0,3}>\s?/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next))
  );
}

function listItem(text: string): MarkdownListItem {
  const task = TASK.exec(text);
  return task
    ? { text: task[2]!, checked: task[1] !== " ", children: [] }
    : { text, checked: null, children: [] };
}

/** Parses the list starting at `start`, including lists nested under its items. */
function parseList(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const base = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const items: MarkdownListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      // A blank line keeps the list going only when more of it follows.
      let ahead = index + 1;
      while (ahead < lines.length && !lines[ahead]!.trim()) ahead++;
      const following = lines[ahead];
      const item = following === undefined ? null : LIST_ITEM.exec(following);
      if (
        item ? indentOf(item[1]!) >= base : following && indentOf(/^\s*/.exec(following)![0]) > base
      ) {
        index = ahead;
        continue;
      }
      break;
    }
    const item = LIST_ITEM.exec(line);
    const indent = item ? indentOf(item[1]!) : indentOf(/^\s*/.exec(line)![0]);
    if (item && indent < base) break;
    if (item && indent <= base + 1) {
      items.push(listItem(item[3]!));
      index++;
      continue;
    }
    if (item && items.length) {
      const nested = parseList(lines, index);
      items[items.length - 1]!.children.push(nested.block);
      index = nested.next;
      continue;
    }
    if (indent > base && items.length) {
      const last = items[items.length - 1]!;
      last.text += ` ${line.trim()}`;
      index++;
      continue;
    }
    break;
  }
  return {
    block: { kind: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items },
    next: index,
  };
}

/**
 * The Markdown models write, with no raw HTML: headings, paragraphs, nested and task lists,
 * fenced code, quotes, tables and rules. An unclosed fence (a reply still streaming) is code.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith(marker))
        body.push(lines[index++]!);
      index++;
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[2] ?? "" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3,
        text: heading[2]!,
      });
      index++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index++;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim())
        rows.push(tableCells(lines[index++]!));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index]!))
        quoted.push(lines[index++]!.replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !startsBlock(lines[index]!, lines[index + 1])
    )
      paragraph.push(lines[index++]!);
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

/**
 * Inline tokens, earliest alternative first: code, links and images, autolinks, bare URLs (before
 * emphasis, so underscores in a URL stay literal), bold, strikethrough, italic. Underscore emphasis
 * only applies at word boundaries (`snake_case_name` is not italic).
 */
const INLINE = new RegExp(
  [
    /(`[^`\n]+`)/.source,
    /(!?\[[^\]\n]*\]\([^)\s]+(?:\s+"[^"\n]*")?\))/.source,
    /(<https?:\/\/[^>\s]+>)/.source,
    /(https?:\/\/[^\s<>"]+)/.source,
    /(\*\*(?:[^*\n]|\*(?!\*))+?\*\*|(?<![\w])__[^_\n]+?__(?![\w]))/.source,
    /(~~[^~\n]+~~)/.source,
    /(\*[^*\s](?:[^*\n]*[^*\s])?\*|(?<![\w])_[^_\s](?:[^_\n]*[^_\s])?_(?![\w]))/.source,
  ].join("|"),
  "g",
);

const LINK_CLASSES =
  "font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors [overflow-wrap:anywhere] hover:decoration-primary";

/** Splits a bare URL from punctuation that ends the sentence around it. */
function trimUrl(url: string): [string, string] {
  let end = url.length;
  while (end > 0 && /[.,;:!?'"*_]/.test(url[end - 1]!)) end--;
  // Keep a closing parenthesis only when the URL opened one.
  while (end > 0 && url[end - 1] === ")") {
    const opens = url.slice(0, end).split("(").length - 1;
    const closes = url.slice(0, end).split(")").length - 1;
    if (closes <= opens) break;
    end--;
  }
  return [url.slice(0, end), url.slice(end)];
}

function link(key: string, href: string, label: ReactNode, title?: string): ReactNode {
  if (!SAFE_LINK.test(href)) return label;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={LINK_CLASSES}
    >
      {label}
    </a>
  );
}

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let count = 0;
  for (const match of text.matchAll(INLINE)) {
    const [token] = match;
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    const key = `${keyPrefix}-${count++}`;
    if (match[1]) {
      nodes.push(
        <code
          key={key}
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      const [, bang, label, href] = /^(!?)\[([^\]]*)\]\(([^)\s]+)/.exec(token)!;
      // Images from model output are never loaded; they show as a link to the image.
      const text = label || (bang ? "Image" : href!);
      nodes.push(link(key, href!, bang ? text : renderInline(text, key), href));
    } else if (match[3]) {
      const href = token.slice(1, -1);
      nodes.push(link(key, href, shortUrl(href), href));
    } else if (match[4]) {
      const [href, rest] = trimUrl(token);
      nodes.push(link(key, href, shortUrl(href), href));
      if (rest) nodes.push(rest);
    } else if (match[5]) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (match[6]) {
      nodes.push(
        <del key={key} className="text-muted-foreground">
          {renderInline(token.slice(2, -2), key)}
        </del>,
      );
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    cursor = at + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function withLineBreaks(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      index === 0
        ? renderInline(line, `${keyPrefix}-${index}`)
        : [<br key={`${keyPrefix}-br-${index}`} />, ...renderInline(line, `${keyPrefix}-${index}`)],
    );
}

function CodeBlock({ text, lang }: { text: string; lang: string }) {
  return (
    <div className="group/code overflow-hidden rounded-lg border border-border bg-surface-sunken">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-border/70 pl-3 pr-1">
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {lang || "code"}
        </span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ListBlock({
  block,
  keyPrefix,
}: {
  block: Extract<MarkdownBlock, { kind: "list" }>;
  keyPrefix: string;
}) {
  const tasks = block.items.every((item) => item.checked !== null);
  const List = block.ordered ? "ol" : "ul";
  return (
    <List
      start={block.ordered && block.start !== 1 ? block.start : undefined}
      className={cn(
        "space-y-1 marker:text-muted-foreground",
        tasks ? "pl-0.5" : "pl-5",
        !tasks && (block.ordered ? "list-decimal" : "list-disc"),
      )}
    >
      {block.items.map((item, itemIndex) => {
        const key = `${keyPrefix}-${itemIndex}`;
        return (
          <li key={itemIndex} className={cn("pl-0.5", tasks && "list-none")}>
            {item.checked !== null ? (
              <span className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  tabIndex={-1}
                  aria-label={item.checked ? "Done" : "Not done"}
                  className="mt-[0.3em] size-3.5 shrink-0 accent-primary"
                />
                <span className={cn(item.checked && "text-muted-foreground line-through")}>
                  {renderInline(item.text, key)}
                </span>
              </span>
            ) : (
              renderInline(item.text, key)
            )}
            {item.children.length ? (
              <div className="mt-1">
                {item.children.map((child, childIndex) =>
                  child.kind === "list" ? (
                    <ListBlock key={childIndex} block={child} keyPrefix={`${key}-${childIndex}`} />
                  ) : null,
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </List>
  );
}

const HEADING_CLASSES: Record<1 | 2 | 3, string> = {
  1: "text-base font-semibold tracking-tight",
  2: "text-[0.95rem] font-semibold",
  3: "font-semibold",
};

/**
 * Renders model Markdown. Links open in a new tab; long URLs and words wrap instead of widening
 * the container, so it is safe in narrow panels.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-3 [overflow-wrap:anywhere] [&>[role=heading]]:!mb-1.5",
        className,
      )}
    >
      {parseMarkdown(source).map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "heading":
            return (
              <p
                key={key}
                role="heading"
                aria-level={block.level + 2}
                className={cn(HEADING_CLASSES[block.level], index > 0 && "pt-1.5")}
              >
                {renderInline(block.text, key)}
              </p>
            );
          case "paragraph":
            return <p key={key}>{withLineBreaks(block.text, key)}</p>;
          case "list":
            return <ListBlock key={key} block={block} keyPrefix={key} />;
          case "code":
            return <CodeBlock key={key} text={block.text} lang={block.lang} />;
          case "quote":
            return (
              <blockquote
                key={key}
                className="border-l-2 border-border-strong/60 pl-3 text-muted-foreground"
              >
                {withLineBreaks(block.text, key)}
              </blockquote>
            );
          case "rule":
            return <hr key={key} className="border-border" />;
          case "table":
            return (
              <div key={key} className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-[0.85em]">
                  <thead className="bg-surface-sunken">
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th
                          key={cellIndex}
                          scope="col"
                          className="border-b border-border px-2.5 py-1.5 font-semibold [overflow-wrap:normal]"
                        >
                          {renderInline(cell, `${key}-h${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="px-2.5 py-1.5 align-top [overflow-wrap:normal]"
                          >
                            {renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
