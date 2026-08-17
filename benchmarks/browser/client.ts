import { memFactory } from "../compare/mem.ts";
import { printReport, runSuite } from "../harness/run-suite.ts";
import type { SuiteTier } from "../harness/types.ts";
import { allSpecs } from "../workloads/index.ts";

const params = new URLSearchParams(location.search);
const tier = (params.get("tier") ?? "ci") as SuiteTier;
const grep = params.get("grep") ?? undefined;

let specs = allSpecs().filter((spec) => !spec.engines?.startsWith("compare"));
if (grep) specs = specs.filter((spec) => spec.name.includes(grep));

const report = await runSuite({
  factories: [memFactory],
  specs,
  tier,
  environment: {
    runtime: "browser",
    browser: navigator.userAgent,
    userAgent: navigator.userAgent,
  },
});

printReport(report);
(window as unknown as { __BENCH__: typeof report }).__BENCH__ = report;
document.body.textContent = `ok ${report.results.length} results`;
