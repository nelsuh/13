// Run every 13/ suite. Exits non-zero if anything fails.
//   node 13/test/run_all.cjs
// Each suite also runs standalone: node 13/test/t_adversity.cjs

const SUITES = ["./t_rules.cjs", "./t_offline.cjs", "./t_online.cjs", "./t_adversity.cjs", "./t_findings.cjs"];

(async () => {
  const results = [];
  for (const path of SUITES) {
    // each suite registers into its own module-scoped test list
    delete require.cache[require.resolve("./lib/tap.cjs")];
    const mod = require(path);
    results.push(await mod.run());
  }
  console.log("\n================ SUMMARY ================");
  let total = 0, passed = 0;
  for (const r of results) {
    total += r.total; passed += r.pass;
    console.log(`  ${r.pass === r.total ? "OK  " : "FAIL"}  ${r.label.padEnd(10)} ${r.pass}/${r.total}`);
  }
  console.log(`  ----  ${"TOTAL".padEnd(10)} ${passed}/${total}`);
  const fails = results.flatMap(r => r.fails.map(f => r.label + " › " + f.name));
  if (fails.length) {
    console.log("\n  Failing:");
    fails.forEach(f => console.log("    - " + f));
    console.log("\n  (The FINDINGS suite is expected to fail until the bugs it documents are fixed.)");
  }
  process.exit(results.some(r => r.label !== "FINDINGS" && r.fails.length) ? 1 : 0);
})();
