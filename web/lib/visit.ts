export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function visit(tree: unknown, visitor: (node: HastNode) => void): void {
  walk(tree as HastNode);
  function walk(n: HastNode) {
    if (!n || typeof n !== "object") return;
    visitor(n);
    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  }
}
