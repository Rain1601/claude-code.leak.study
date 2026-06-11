import Link from "next/link";
import {
  getNotesByPhase,
  getPhaseLabel,
  type NoteMeta,
  type Phase,
} from "@/lib/notes";
import styles from "./page.module.css";

const PHASE_INTRO: Record<Phase, string> = {
  phase1:
    "把 Claude Code 一次用户输入到下一轮的 turn 生命周期走完一遍,提炼 immutable-state-machine、Tool 接口、isConcurrencySafe 调度等可借鉴设计。",
  phase2:
    "工具系统(Tool 接口规约、注册表、StreamingToolExecutor、ToolSearch 按需加载)与上下文压缩(5 层流水线)。",
};

export default function NotesIndexPage() {
  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.kicker}>NOTES INDEX</div>
        <h1 className={styles.title}>学习笔记目录</h1>
        <p className={styles.lede}>
          按阶段组织;每个阶段下有"主笔记"(整体框架)和"问答"(针对某个细节的深挖,带源码引用)。
        </p>
      </header>

      {(["phase1", "phase2"] as const).map((phase) => {
        const notes = getNotesByPhase(phase);
        const mains = notes.filter((n) => n.kind === "main");
        const qaIndex = notes.find((n) => n.kind === "qa-index");
        const qas = notes.filter((n) => n.kind === "qa");
        return (
          <section key={phase} className={styles.phase}>
            <div className={styles.phaseHead}>
              <div className={styles.phaseTag}>{phase.toUpperCase()}</div>
              <h2 className={styles.phaseTitle}>{getPhaseLabel(phase)}</h2>
              <p className={styles.phaseLede}>{PHASE_INTRO[phase]}</p>
            </div>

            <div className={styles.group}>
              <div className={styles.groupLabel}>主笔记</div>
              <ul className={styles.list}>
                {mains.map((n) => (
                  <NoteRow key={n.href} note={n} />
                ))}
              </ul>
            </div>

            {qas.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>
                  问答 · {qas.length} 篇
                  {qaIndex && (
                    <Link href={qaIndex.href} className={styles.indexLink}>
                      索引 →
                    </Link>
                  )}
                </div>
                <ul className={styles.list}>
                  {qas.map((n) => (
                    <NoteRow key={n.href} note={n} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function NoteRow({ note }: { note: NoteMeta }) {
  return (
    <li className={styles.row}>
      <Link href={note.href} className={styles.rowLink}>
        <div className={styles.rowMain}>
          {typeof note.qaNumber === "number" && (
            <span className={styles.rowNumber}>
              Q{String(note.qaNumber).padStart(2, "0")}
            </span>
          )}
          <span className={styles.rowTitle}>{note.title}</span>
        </div>
        {note.subtitle && (
          <div className={styles.rowSubtitle}>{note.subtitle}</div>
        )}
      </Link>
    </li>
  );
}
