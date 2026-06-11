import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getAllNotes,
  getNoteBySlug,
  getNotesByPhase,
  getPhaseLabel,
  readNoteContent,
} from "@/lib/notes";
import { renderMarkdown } from "@/lib/markdown";
import styles from "./page.module.css";

interface Props {
  params: Promise<{ slug: string[] }>;
}

export async function generateStaticParams() {
  return getAllNotes().map((n) => ({ slug: n.slug }));
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const note = getNoteBySlug(slug);
  if (!note) return {};
  return {
    title: `${note.title} · 学习笔记`,
    description: note.subtitle,
  };
}

export default async function NotePage({ params }: Props) {
  const { slug } = await params;
  const note = getNoteBySlug(slug);
  if (!note) notFound();

  const source = readNoteContent(note);
  const { html, headings } = await renderMarkdown(source, note);

  const sameP = getNotesByPhase(note.phase);
  const prevIdx = sameP.findIndex((n) => n.href === note.href) - 1;
  const nextIdx = sameP.findIndex((n) => n.href === note.href) + 1;
  const prev = prevIdx >= 0 ? sameP[prevIdx] : null;
  const next = nextIdx < sameP.length ? sameP[nextIdx] : null;

  const kindLabel =
    note.kind === "main" ? "主笔记" : note.kind === "qa-index" ? "问答索引" : "问答";

  return (
    <div className={styles.wrap}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarStick}>
          <Link href="/notes" className={styles.back}>
            ← 所有笔记
          </Link>
          <div className={styles.phaseTag}>
            {note.phase.toUpperCase()} · {kindLabel}
          </div>
          {headings.length > 0 && (
            <>
              <div className={styles.tocLabel}>本页目录</div>
              <ul className={styles.toc}>
                {headings
                  .filter((h) => h.depth <= 3 && h.depth >= 2)
                  .map((h) => (
                    <li
                      key={h.id}
                      className={styles.tocItem}
                      data-depth={h.depth}
                    >
                      <a href={`#${h.id}`}>{h.text}</a>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      </aside>

      <article className={styles.article}>
        <header className={styles.articleHead}>
          <div className={styles.crumbs}>
            <Link href="/notes">笔记</Link>
            <span>/</span>
            <span>{getPhaseLabel(note.phase)}</span>
            <span>/</span>
            <span className={styles.crumbCurrent}>{kindLabel}</span>
          </div>
        </header>
        <div
          className={styles.prose}
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <nav className={styles.pager}>
          {prev ? (
            <Link href={prev.href} className={styles.pagerLink}>
              <span className={styles.pagerLabel}>← 上一篇</span>
              <span className={styles.pagerTitle}>{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={next.href}
              className={`${styles.pagerLink} ${styles.pagerLinkRight}`}
            >
              <span className={styles.pagerLabel}>下一篇 →</span>
              <span className={styles.pagerTitle}>{next.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
    </div>
  );
}
