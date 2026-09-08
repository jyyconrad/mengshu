import { describe, expect, test } from "vitest";
import { parseDiagnosticCli } from "./cli.js";

describe("evolution diagnostic CLI opt-in", () => {
  test("has no default global dataset, output or execution mode", () => {
    for (const argv of [[], ["--synthetic"], ["--output", "/tmp/new"], ["--synthetic", "--output", "relative"],
      ["--synthetic", "--output", "/tmp/new", "--adapter", "/tmp/driver.ts"], ["--unknown"]]) {
      expect(() => parseDiagnosticCli(argv)).toThrow();
    }
  });
  test("accepts explicit offline smoke or operator-supplied frozen dataset and driver", () => {
    expect(parseDiagnosticCli(["--synthetic", "--output", "/tmp/new"]))
      .toEqual({ synthetic: true, output: "/tmp/new" });
    expect(parseDiagnosticCli(["--dataset", "/tmp/data.json", "--adapter", "/tmp/driver.ts", "--output", "/tmp/new"]))
      .toEqual({ synthetic: false, dataset: "/tmp/data.json", adapter: "/tmp/driver.ts", output: "/tmp/new" });
  });
});
