import fs from "node:fs";
import path from "node:path";

const RESEARCH_DIR = path.join(process.cwd(), "..", "docs", "research");

export type Phase = "phase1" | "phase2" | "phase3";

export type NoteKind = "main" | "qa" | "qa-index";

export interface NoteMeta {
  slug: string[];          // URL parts after /notes/
  href: string;            // joined /notes/...
  filePath: string;        // absolute path to .md
  phase: Phase;
  kind: NoteKind;
  title: string;
  subtitle?: string;
  order: number;
  qaNumber?: number;
}

const PHASE_LABELS: Record<Phase, string> = {
  phase1: "Phase 1 · Agent Loop 骨架",
  phase2: "Phase 2 · 工具系统与上下文压缩",
  phase3: "Phase 3 · 记忆系统(Memory)",
};

export function getPhaseLabel(p: Phase): string {
  return PHASE_LABELS[p];
}

/** Strip YAML frontmatter if present and return body + first H1 */
function readMarkdown(filePath: string): { raw: string; title: string; subtitle?: string } {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");

  let title = path.basename(filePath, ".md");
  let subtitle: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      title = trimmed.replace(/^#\s+/, "").trim();
      break;
    }
  }

  // First "> " quote line under the H1 — treat as subtitle/lede.
  let sawTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!sawTitle && trimmed.startsWith("# ")) {
      sawTitle = true;
      continue;
    }
    if (sawTitle && trimmed.startsWith(">")) {
      subtitle = trimmed.replace(/^>+\s*/, "").trim();
      if (subtitle.length > 200) subtitle = subtitle.slice(0, 200) + "…";
      break;
    }
    if (sawTitle && trimmed.length > 0 && !trimmed.startsWith(">")) {
      break;
    }
  }

  return { raw, title, subtitle };
}

interface NoteSpec {
  slug: string[];
  filePath: string;
  phase: Phase;
  kind: NoteKind;
  order: number;
  qaNumber?: number;
}

function buildSpecs(): NoteSpec[] {
  const specs: NoteSpec[] = [];

  // Phase 1
  specs.push({
    slug: ["phase1"],
    filePath: path.join(RESEARCH_DIR, "phase1-agent-loop.md"),
    phase: "phase1",
    kind: "main",
    order: 0,
  });
  specs.push({
    slug: ["phase1", "qa"],
    filePath: path.join(RESEARCH_DIR, "phase1", "question.md"),
    phase: "phase1",
    kind: "qa-index",
    order: 1,
  });
  const phase1QaDir = path.join(RESEARCH_DIR, "phase1");
  for (const name of fs.readdirSync(phase1QaDir)) {
    const m = name.match(/^qa(\d+)\.(.+)\.md$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const topic = m[2];
    specs.push({
      slug: ["phase1", "qa", topic],
      filePath: path.join(phase1QaDir, name),
      phase: "phase1",
      kind: "qa",
      order: 10 + n,
      qaNumber: n,
    });
  }

  // Phase 2
  specs.push({
    slug: ["phase2", "tool-system"],
    filePath: path.join(RESEARCH_DIR, "phase2-tool-system.md"),
    phase: "phase2",
    kind: "main",
    order: 100,
  });
  specs.push({
    slug: ["phase2", "context-compaction"],
    filePath: path.join(RESEARCH_DIR, "phase2-context-compaction.md"),
    phase: "phase2",
    kind: "main",
    order: 101,
  });
  specs.push({
    slug: ["phase2", "qa"],
    filePath: path.join(RESEARCH_DIR, "phase2", "question.md"),
    phase: "phase2",
    kind: "qa-index",
    order: 102,
  });
  const phase2QaDir = path.join(RESEARCH_DIR, "phase2");
  for (const name of fs.readdirSync(phase2QaDir)) {
    const m = name.match(/^qa(\d+)\.(.+)\.md$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const topic = m[2];
    specs.push({
      slug: ["phase2", "qa", topic],
      filePath: path.join(phase2QaDir, name),
      phase: "phase2",
      kind: "qa",
      order: 110 + n,
      qaNumber: n,
    });
  }

  // Phase 3
  specs.push({
    slug: ["phase3"],
    filePath: path.join(RESEARCH_DIR, "phase3-memory.md"),
    phase: "phase3",
    kind: "main",
    order: 200,
  });
  specs.push({
    slug: ["phase3", "qa"],
    filePath: path.join(RESEARCH_DIR, "phase3", "question.md"),
    phase: "phase3",
    kind: "qa-index",
    order: 201,
  });
  const phase3QaDir = path.join(RESEARCH_DIR, "phase3");
  if (fs.existsSync(phase3QaDir)) {
    for (const name of fs.readdirSync(phase3QaDir)) {
      const m = name.match(/^qa(\d+)\.(.+)\.md$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      const topic = m[2];
      specs.push({
        slug: ["phase3", "qa", topic],
        filePath: path.join(phase3QaDir, name),
        phase: "phase3",
        kind: "qa",
        order: 210 + n,
        qaNumber: n,
      });
    }
  }

  return specs;
}

let cached: NoteMeta[] | null = null;

export function getAllNotes(): NoteMeta[] {
  if (cached) return cached;
  const specs = buildSpecs();
  const notes = specs
    .filter((s) => fs.existsSync(s.filePath))
    .map((s) => {
      const { title, subtitle } = readMarkdown(s.filePath);
      return {
        ...s,
        href: "/notes/" + s.slug.join("/"),
        title,
        subtitle,
      } satisfies NoteMeta;
    });
  notes.sort((a, b) => a.order - b.order);
  cached = notes;
  return notes;
}

export function getNoteBySlug(slug: string[]): NoteMeta | null {
  const target = slug.join("/");
  return getAllNotes().find((n) => n.slug.join("/") === target) ?? null;
}

export function getNotesByPhase(phase: Phase): NoteMeta[] {
  return getAllNotes().filter((n) => n.phase === phase);
}

export function readNoteContent(note: NoteMeta): string {
  return fs.readFileSync(note.filePath, "utf8");
}
