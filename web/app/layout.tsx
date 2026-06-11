import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import styles from "./layout.module.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Claude Code 源码学习笔记",
  description:
    "拆解泄露的 Claude Code 源码,梳理 agent loop、工具系统、上下文压缩等设计细节的学习笔记。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={inter.variable}>
      <body>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Link href="/" className={styles.logo}>
              <span className={styles.logoMark}>※</span>
              <span className={styles.logoText}>claude-code · notes</span>
            </Link>
            <nav className={styles.nav}>
              <Link href="/notes">所有笔记</Link>
              <Link href="/notes/phase1">Phase 1</Link>
              <Link href="/notes/phase2">Phase 2</Link>
              <a
                href="https://github.com/Rain1601/claude-code.leak.study"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </nav>
          </div>
        </header>

        <main className={styles.main}>{children}</main>

        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            <span>静态归档 · 仅用于学习</span>
            <span className={styles.footerSep}>·</span>
            <span>源代码摘自泄露的 npm sourcemap (2026-03)</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
