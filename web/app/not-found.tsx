import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        maxWidth: "var(--width-prose)",
        margin: "0 auto",
        padding: "var(--spacing-3xl) var(--spacing-lg)",
        fontFamily: "var(--font-serif)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-ui)",
          fontSize: "0.75rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--accent-primary)",
          marginBottom: "var(--spacing-sm)",
        }}
      >
        404
      </div>
      <h1
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "2.5rem",
          letterSpacing: "-0.03em",
          color: "var(--text-primary)",
          margin: "0 0 var(--spacing-md)",
        }}
      >
        没找到这页笔记
      </h1>
      <p style={{ color: "var(--text-tertiary)", marginBottom: "var(--spacing-lg)" }}>
        可能是链接过时,或者笔记还没写。
      </p>
      <Link
        href="/notes"
        style={{
          fontFamily: "var(--font-ui)",
          color: "var(--accent-primary)",
        }}
      >
        ← 回到笔记列表
      </Link>
    </div>
  );
}
