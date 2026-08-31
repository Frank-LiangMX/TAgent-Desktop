/**
 * Markdown memory scope helpers.
 *
 * Legacy Markdown entries predate workspace metadata. When a project context
 * is available, those entries must not be injected into the project prompt.
 */
export function filterProjectMemoryMarkdown(
  content: string,
  workspaceSlug?: string,
): string {
  if (!workspaceSlug) return content;

  const workspaceToken = `workspace:${encodeURIComponent(workspaceSlug)}`;
  return content
    .split(/\r?\n/)
    .filter(
      (line) => !line.trim().startsWith("- ") || line.includes(workspaceToken),
    )
    .join("\n");
}
