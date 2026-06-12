import Link from "next/link";
import { getAllNotes, getNotesByPhase, getPhaseLabel } from "@/lib/notes";
import styles from "./page.module.css";

export default function HomePage() {
  const phase1 = getNotesByPhase("phase1");
  const phase2 = getNotesByPhase("phase2");
  const phase3 = getNotesByPhase("phase3");
  const totalQa = getAllNotes().filter((n) => n.kind === "qa").length;
  const totalNotes = phase1.length + phase2.length + phase3.length;

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className={styles.kicker}>STUDY ARCHIVE · 2026</div>
        <h1 className={styles.title}>
          拆解 Claude Code 源码,<br />写一份给后端工程师的学习笔记
        </h1>
        <p className={styles.lede}>
          这是一个对泄露的 Claude Code(npm sourcemap, 2026-03)源码的研究归档,
          关注 agent loop、工具系统、上下文压缩等"做大了一定会演化出来"的设计,
          配合可链接的 Q&amp;A 把问题一条条问清楚。
        </p>
        <div className={styles.heroActions}>
          <Link href="/notes" className={styles.ctaPrimary}>
            浏览全部笔记
          </Link>
          <Link href="/notes/phase1" className={styles.ctaGhost}>
            从 Phase 1 开始 →
          </Link>
        </div>
      </section>

      <section className={styles.stats}>
        <div className={styles.statItem}>
          <div className={styles.statNum}>3</div>
          <div className={styles.statLabel}>研究阶段</div>
        </div>
        <div className={styles.statItem}>
          <div className={styles.statNum}>{totalQa}</div>
          <div className={styles.statLabel}>Q&amp;A 深挖</div>
        </div>
        <div className={styles.statItem}>
          <div className={styles.statNum}>{totalNotes}</div>
          <div className={styles.statLabel}>笔记总数</div>
        </div>
      </section>

      <section className={styles.phases}>
        <PhaseCard
          phase="phase1"
          label={getPhaseLabel("phase1")}
          summary="一次用户输入 → LLM 调用 → 工具调用 → 结果回填 → 下一轮。把 QueryEngine / query.ts / toolOrchestration 的 turn 生命周期画出来,提炼可借鉴的 immutable-state-machine 设计。"
          notes={phase1}
        />
        <PhaseCard
          phase="phase2"
          label={getPhaseLabel("phase2")}
          summary="工具系统(Tool 接口规约、注册表、StreamingToolExecutor、ToolSearch 按需加载)与上下文压缩(snip / microcompact / contextCollapse / autocompact 5 层流水线)的设计细节。"
          notes={phase2}
        />
        <PhaseCard
          phase="phase3"
          label={getPhaseLabel("phase3")}
          summary="记忆系统(memdir、autoDream、Agent memory snapshot、Team memory)。MEMORY.md 怎么注入,sideQuery 怎么 prefetch 相关记忆,后台 forked agent 怎么跨 session 巩固。"
          notes={phase3}
        />
      </section>
    </div>
  );
}

function PhaseCard({
  phase,
  label,
  summary,
  notes,
}: {
  phase: string;
  label: string;
  summary: string;
  notes: ReturnType<typeof getAllNotes>;
}) {
  const main = notes.filter((n) => n.kind === "main");
  const qaCount = notes.filter((n) => n.kind === "qa").length;
  return (
    <article className={styles.phaseCard}>
      <header className={styles.phaseHeader}>
        <div className={styles.phaseTag}>{phase.toUpperCase()}</div>
        <h2 className={styles.phaseTitle}>{label}</h2>
        <p className={styles.phaseSummary}>{summary}</p>
      </header>

      <div className={styles.phaseBody}>
        <div className={styles.phaseSection}>
          <div className={styles.phaseSectionLabel}>主笔记</div>
          <ul className={styles.phaseList}>
            {main.map((n) => (
              <li key={n.href}>
                <Link href={n.href}>{n.title}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.phaseSection}>
          <div className={styles.phaseSectionLabel}>问答 · {qaCount} 篇</div>
          <Link href={`/notes/${phase}/qa`} className={styles.phaseAll}>
            查看问答索引 →
          </Link>
        </div>
      </div>
    </article>
  );
}
