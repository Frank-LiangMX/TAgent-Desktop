import { describe, expect, it } from "vitest";
import { filterProjectMemoryMarkdown } from "./memory-scope";

describe("filterProjectMemoryMarkdown", () => {
  it("keeps legacy/global content when no project is selected", () => {
    const content = "# Project\n\n- legacy entry\n";
    expect(filterProjectMemoryMarkdown(content)).toBe(content);
  });

  it("keeps headers and matching project entries but excludes legacy and other projects", () => {
    const content = [
      "# Project",
      "",
      "- legacy entry",
      "- current entry <!-- scope:project workspace:workspace-a status:active -->",
      "- other entry <!-- scope:project workspace:workspace-b status:active -->",
    ].join("\n");

    expect(filterProjectMemoryMarkdown(content, "workspace-a")).toBe(
      [
        "# Project",
        "",
        "- current entry <!-- scope:project workspace:workspace-a status:active -->",
      ].join("\n"),
    );
  });
});
