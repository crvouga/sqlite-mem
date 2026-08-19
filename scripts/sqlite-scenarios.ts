/**
 * Construct-level scenario catalog gate.
 * Run: bun run scripts/sqlite-scenarios.ts
 *      bun run scenarios
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIO_CATALOG, knownScenarioIds } from "../compat/scenarios.ts";
import { SCENARIO_ID_RE, SECTION_CODES, type SectionCode } from "../compat/scenario-types.ts";

const ROOT = join(import.meta.dir, "..");

const ID_IN_TESTS_RE = new RegExp(`\\b(?:${SECTION_CODES.join("|")})-(?:[a-z0-9]+-)*\\d{2,}\\b`, "g");

export interface ScenarioGateStats {
  sections: number;
  promoted: number;
  total: number;
  mapped: number;
}

export interface ScenarioGateResult {
  failures: string[];
  stats: ScenarioGateStats;
}

function walkTsFiles(dir: string): string[] {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: dir, onlyFiles: true })].map((rel) => join(dir, rel));
}

export function validateScenarioCatalog(root = ROOT): ScenarioGateResult {
  const failures: string[] = [];
  const known = knownScenarioIds();
  const seenIds = new Set<string>();
  let mapped = 0;

  for (const section of SCENARIO_CATALOG) {
    if (!SECTION_CODES.includes(section.code as SectionCode)) {
      failures.push(`Unknown section code ${section.code}`);
    }
    for (const scenario of section.scenarios) {
      if (seenIds.has(scenario.id)) failures.push(`Duplicate scenario id ${scenario.id}`);
      seenIds.add(scenario.id);
      if (!SCENARIO_ID_RE.test(scenario.id)) failures.push(`Malformed scenario id ${scenario.id}`);
      const prefix = scenario.id.slice(0, 3);
      if (prefix !== section.code) failures.push(`Scenario ${scenario.id} is not in section ${section.code}`);
      if (scenario.evidence.length === 0) {
        if (section.promoted) failures.push(`Promoted ${scenario.id} has no evidence`);
        continue;
      }
      let foundInEvidence = false;
      for (const rel of scenario.evidence) {
        const abs = join(root, rel);
        if (!existsSync(abs)) {
          failures.push(`${scenario.id} evidence missing: ${rel}`);
          continue;
        }
        const text = readFileSync(abs, "utf8");
        if (text.includes(scenario.id)) foundInEvidence = true;
      }
      if (!foundInEvidence) {
        if (section.promoted) {
          failures.push(`Promoted ${scenario.id} not found in evidence files`);
        }
      } else {
        mapped += 1;
      }
      if (section.promoted && !foundInEvidence && scenario.evidence.every((rel) => existsSync(join(root, rel)))) {
        // already pushed if missing id in files
      }
    }
  }

  const testsDir = join(root, "tests");
  if (existsSync(testsDir)) {
    for (const file of walkTsFiles(testsDir)) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(ID_IN_TESTS_RE) ?? [];
      for (const id of matches) {
        if (!known.has(id)) {
          failures.push(`Unknown scenario id ${id} in ${file.slice(root.length + 1)}`);
        }
      }
    }
  }

  const stats: ScenarioGateStats = {
    sections: SCENARIO_CATALOG.length,
    promoted: SCENARIO_CATALOG.filter((section) => section.promoted).length,
    total: known.size,
    mapped,
  };
  return { failures, stats };
}

export function printScenarioSummary(result: ScenarioGateResult): void {
  const { stats } = result;
  console.log(
    `scenario catalog: promoted ${stats.promoted}/${stats.sections} sections, mapped ${stats.mapped}/${stats.total} ids`,
  );
  for (const section of SCENARIO_CATALOG) {
    const mapped = section.scenarios.filter((scenario) =>
      scenario.evidence.some((rel) => {
        const abs = join(ROOT, rel);
        return existsSync(abs) && readFileSync(abs, "utf8").includes(scenario.id);
      }),
    ).length;
    const flag = section.promoted ? "PROMOTED" : "open";
    console.log(`  ${section.code} ${flag} ${mapped}/${section.scenarios.length}  ${section.title}`);
  }
}

if (import.meta.main) {
  const result = validateScenarioCatalog();
  printScenarioSummary(result);
  if (result.failures.length > 0) {
    console.error("scenario catalog FAILED:");
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("scenario catalog OK");
}
