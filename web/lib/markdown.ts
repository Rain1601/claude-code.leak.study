import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeStringify from "rehype-stringify";
import { visit, type HastNode } from "./visit";
import type { NoteMeta } from "./notes";

export interface HeadingEntry {
  depth: number;
  text: string;
  id: string;
}

/** Map an internal markdown link to its web URL. */
function resolveInternalLink(href: string, currentNote: NoteMeta): string | null {
  // Skip external & anchor-only.
  if (/^(https?:)?\/\//.test(href)) return null;
  if (href.startsWith("#") || href.startsWith("mailto:")) return null;

  // Resolve relative to the source markdown file's directory.
  const sourceDir = path.dirname(currentNote.filePath);
  const target = path.resolve(sourceDir, href.split("#")[0]);
  const anchor = href.includes("#") ? "#" + href.split("#").slice(1).join("#") : "";

  // Match against research dir.
  // We compute relative path back from RESEARCH_DIR.
  const researchDir = path.resolve(sourceDir, sourceDir.endsWith("phase1") || sourceDir.endsWith("phase2") ? ".." : ".");
  const rel = path.relative(researchDir, target);

  // Possible matches:
  //   phase1-agent-loop.md             → /notes/phase1
  //   phase1/question.md               → /notes/phase1/qa
  //   phase1/qa05.memoryMechanicsPromptExample.md → /notes/phase1/qa/memoryMechanicsPromptExample
  //   phase2-tool-system.md            → /notes/phase2/tool-system
  //   phase2-context-compaction.md     → /notes/phase2/context-compaction
  //   phase2/question.md               → /notes/phase2/qa
  //   phase2/qa01.multipleToolsHandling.md → /notes/phase2/qa/multipleToolsHandling
  const mainMain = rel.match(/^phase1-agent-loop\.md$/);
  if (mainMain) return "/notes/phase1" + anchor;
  const toolSystem = rel.match(/^phase2-tool-system\.md$/);
  if (toolSystem) return "/notes/phase2/tool-system" + anchor;
  const compaction = rel.match(/^phase2-context-compaction\.md$/);
  if (compaction) return "/notes/phase2/context-compaction" + anchor;
  const qIndex = rel.match(/^(phase[12])\/question\.md$/);
  if (qIndex) return `/notes/${qIndex[1]}/qa` + anchor;
  const qa = rel.match(/^(phase[12])\/qa\d+\.(.+)\.md$/);
  if (qa) return `/notes/${qa[1]}/qa/${qa[2]}` + anchor;

  return null;
}

export interface RenderedNote {
  html: string;
  headings: HeadingEntry[];
}

export async function renderMarkdown(
  source: string,
  note: NoteMeta,
): Promise<RenderedNote> {
  const headings: HeadingEntry[] = [];

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: "append",
      properties: {
        className: ["anchor-link"],
        ariaHidden: "true",
        tabIndex: -1,
      },
      content: { type: "text", value: "#" },
    })
    .use(rehypePrettyCode, {
      theme: { light: "github-light", dark: "github-dark" },
      keepBackground: false,
    })
    .use(() => (tree: unknown) => {
      // Collect headings + rewrite internal links.
      visit(tree, (node) => {
        if (node.type !== "element") return;
        const tag = node.tagName;
        if (tag && /^h[1-6]$/.test(tag)) {
          const depth = parseInt(tag.slice(1), 10);
          const id = node.properties?.id as string | undefined;
          const text = extractText(node);
          if (id) headings.push({ depth, id, text });
        }
        if (tag === "a") {
          const href = node.properties?.href as string | undefined;
          if (!href) return;
          const mapped = resolveInternalLink(href, note);
          if (mapped) {
            node.properties = { ...node.properties, href: mapped };
          } else if (/^(https?:)?\/\//.test(href)) {
            node.properties = {
              ...node.properties,
              target: "_blank",
              rel: "noreferrer",
            };
          }
        }
      });
    })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(source);

  return { html: String(file), headings };
}

function extractText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(extractText).join("");
}
