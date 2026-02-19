import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listMappings,
  getMapping,
  upsertMapping,
  removeMapping,
  _resetForTest,
} from "./linear-project-manager.js";

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "linear-project-manager-test-"));
  filePath = join(tempDir, "linear-projects.json");
  _resetForTest(filePath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("linear-project-manager", () => {
  it("returns empty list when file is missing", () => {
    expect(listMappings()).toEqual([]);
  });

  it("returns null for unknown repo root", () => {
    expect(getMapping("/unknown/repo")).toBeNull();
  });

  it("upsert creates a new mapping", () => {
    const mapping = upsertMapping("/home/user/project", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    expect(mapping.repoRoot).toBe("/home/user/project");
    expect(mapping.teamId).toBe("team-uuid-1");
    expect(mapping.teamKey).toBe("ENG");
    expect(mapping.teamName).toBe("Engineering");
    expect(mapping.createdAt).toBeGreaterThan(0);
    expect(mapping.updatedAt).toBe(mapping.createdAt);
  });

  it("upsert updates an existing mapping", () => {
    const first = upsertMapping("/home/user/project", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    // Small delay to ensure updatedAt differs
    const second = upsertMapping("/home/user/project", {
      teamId: "team-uuid-2",
      teamKey: "DES",
      teamName: "Design",
    });

    expect(second.repoRoot).toBe("/home/user/project");
    expect(second.teamId).toBe("team-uuid-2");
    expect(second.teamKey).toBe("DES");
    expect(second.teamName).toBe("Design");
    // createdAt should be preserved from the first mapping
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    // Should still be only one mapping
    expect(listMappings()).toHaveLength(1);
  });

  it("getMapping retrieves a stored mapping", () => {
    upsertMapping("/home/user/project", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    const mapping = getMapping("/home/user/project");
    expect(mapping).not.toBeNull();
    expect(mapping!.teamKey).toBe("ENG");
  });

  it("removeMapping deletes an entry and returns true", () => {
    upsertMapping("/home/user/project", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    expect(removeMapping("/home/user/project")).toBe(true);
    expect(listMappings()).toHaveLength(0);
    expect(getMapping("/home/user/project")).toBeNull();
  });

  it("removeMapping returns false for unknown repo", () => {
    expect(removeMapping("/unknown/repo")).toBe(false);
  });

  it("normalizes trailing slashes on repoRoot", () => {
    upsertMapping("/home/user/project/", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    // Should find it without trailing slash
    expect(getMapping("/home/user/project")).not.toBeNull();
    expect(getMapping("/home/user/project/")).not.toBeNull();

    // Should be only one mapping
    expect(listMappings()).toHaveLength(1);
    expect(listMappings()[0].repoRoot).toBe("/home/user/project");
  });

  it("persists to disk and survives reload", () => {
    upsertMapping("/home/user/project", {
      teamId: "team-uuid-1",
      teamKey: "ENG",
      teamName: "Engineering",
    });

    // Verify file written to disk
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].teamKey).toBe("ENG");

    // Reset and reload from disk
    _resetForTest(filePath);
    const mapping = getMapping("/home/user/project");
    expect(mapping).not.toBeNull();
    expect(mapping!.teamKey).toBe("ENG");
  });

  it("handles corrupt JSON file gracefully", () => {
    writeFileSync(filePath, "not-json", "utf-8");
    _resetForTest(filePath);

    expect(listMappings()).toEqual([]);
  });

  it("handles non-array JSON file gracefully", () => {
    writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf-8");
    _resetForTest(filePath);

    expect(listMappings()).toEqual([]);
  });

  it("manages multiple mappings", () => {
    upsertMapping("/repo/alpha", {
      teamId: "t1",
      teamKey: "ALPHA",
      teamName: "Alpha Team",
    });
    upsertMapping("/repo/beta", {
      teamId: "t2",
      teamKey: "BETA",
      teamName: "Beta Team",
    });

    expect(listMappings()).toHaveLength(2);
    expect(getMapping("/repo/alpha")!.teamKey).toBe("ALPHA");
    expect(getMapping("/repo/beta")!.teamKey).toBe("BETA");

    removeMapping("/repo/alpha");
    expect(listMappings()).toHaveLength(1);
    expect(getMapping("/repo/alpha")).toBeNull();
    expect(getMapping("/repo/beta")!.teamKey).toBe("BETA");
  });
});
