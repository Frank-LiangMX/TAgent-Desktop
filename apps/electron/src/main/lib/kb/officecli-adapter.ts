/**
 * Optional OfficeCLI bridge for document import.
 *
 * Only the read-only `view <file> text` operation is exposed here. The
 * knowledge-base importer keeps its built-in parser as a fallback so the app
 * remains usable when OfficeCLI is not installed or bundled yet.
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const OFFICECLI_ENV = "TAGENT_OFFICECLI_PATH";
const OFFICECLI_NAME =
  process.platform === "win32" ? "officecli.exe" : "officecli";

function packagedCandidates(): string[] {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    candidates.push(join(resourcesPath, "officecli", OFFICECLI_NAME));
  }
  candidates.push(join(__dirname, "resources", "officecli", OFFICECLI_NAME));
  candidates.push(
    join(__dirname, "..", "resources", "officecli", OFFICECLI_NAME),
  );
  return candidates;
}

export function resolveOfficeCliPath(): string {
  const configured = process.env[OFFICECLI_ENV]?.trim();
  if (configured) return configured;
  return (
    packagedCandidates().find((candidate) => existsSync(candidate)) ??
    OFFICECLI_NAME
  );
}

export async function tryReadDocumentWithOfficeCli(
  filePath: string,
): Promise<string | null> {
  try {
    const result = await execFileAsync(
      resolveOfficeCliPath(),
      ["view", filePath, "text"],
      {
        windowsHide: true,
        timeout: 45_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const text = result.stdout.trim();
    return text || null;
  } catch {
    // Missing optional binary, unsupported format, or CLI parse failure all
    // fall back to the local parser. The importer decides whether that
    // fallback can handle the selected extension.
    return null;
  }
}
