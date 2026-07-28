// Dependency-free async test runner.

const tests = [];
let only = null;

function test(name, fn) { tests.push({ name, fn }); }
test.only = (name, fn) => { only = { name, fn }; tests.push(only); };

function ok(cond, msg) { if (!cond) throw new Error("assert failed: " + (msg || "")); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error("expected " + B + " but got " + A + (msg ? " — " + msg : ""));
}
function ne(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) throw new Error("expected NOT " + JSON.stringify(b) + (msg ? " — " + msg : ""));
}

async function run(label) {
  const list = only ? [only] : tests;
  let pass = 0;
  const fails = [];
  // A test that awaits a virtual-clock promise without advancing the clock
  // empties the event loop and node exits mid-suite, silently. Never let that
  // look like success.
  let finished = false;
  process.on("exit", (code) => {
    if (!finished) {
      console.log("\n!! " + label + " ABORTED after " + (pass + fails.length) + "/" + list.length +
        " tests — the event loop drained (a test awaited a virtual-clock promise?)");
      if (code === 0) process.exitCode = 1;
    }
  });
  process.on("unhandledRejection", (e) => { console.log("!! unhandled rejection: " + (e && e.stack || e)); process.exitCode = 1; });
  console.log("\n=== " + label + " (" + list.length + " tests) ===");
  for (const t of list) {
    const started = Date.now();
    try {
      await t.fn();
      pass++;
      console.log("  PASS  " + t.name + "  (" + (Date.now() - started) + "ms)");
    } catch (e) {
      fails.push({ name: t.name, err: e });
      console.log("  FAIL  " + t.name);
      console.log("        " + String(e.message || e).split("\n").join("\n        "));
    }
  }
  finished = true;
  console.log("--- " + label + ": " + pass + "/" + list.length + " passed");
  return { label, pass, total: list.length, fails };
}

module.exports = { test, ok, eq, ne, run, tests };
