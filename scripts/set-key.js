#!/usr/bin/env node
// Writes an API key into backend/.env without it ever being displayed.
//
//   node scripts/set-key.js                  # OPENAI_API_KEY
//   node scripts/set-key.js ANTHROPIC_API_KEY
//
// Why not just edit the file: pasting a key into a terminal echoes it, which
// puts it into the scrollback and into the shell's history file. This reads it
// with the echo turned off, writes it straight to backend/.env, and reports
// only its length. The value is never printed, logged or passed as an argument.
//
// backend/.env is git-ignored, so the key cannot be committed from there.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, "backend", ".env");

const ALLOWED = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
const VAR = (process.argv[2] || "OPENAI_API_KEY").trim().toUpperCase();

if (!ALLOWED.has(VAR)) {
  console.error(`Refusing to set "${VAR}". This script only sets: ${[...ALLOWED].join(", ")}`);
  process.exit(1);
}

// Reads a line with the terminal's echo disabled, so nothing appears on
// screen as it is typed or pasted. Raw mode delivers pasted input in chunks
// rather than single keystrokes, hence iterating over each chunk.
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error(
          "This needs an interactive terminal (it turns off echo so the key is not displayed).\n" +
            "Run it directly in your own terminal, not through a tool or a pipe."
        )
      );
      return;
    }

    process.stdout.write(question);
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(buf);
        if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };

    stdin.on("data", onData);
  });
}

// Replaces the variable if it is already in the file, appends it if not, and
// leaves every other line exactly as it was.
function upsert(contents, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(contents)) return contents.replace(pattern, line);
  const sep = contents.length && !contents.endsWith("\n") ? "\n" : "";
  return contents + sep + line + "\n";
}

async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    const example = path.join(ROOT, "backend", ".env.example");
    if (fs.existsSync(example)) fs.copyFileSync(example, ENV_FILE);
    else fs.writeFileSync(ENV_FILE, "");
    console.log("Created backend/.env");
  }

  console.log(`\nSetting ${VAR} in backend/.env`);
  console.log("Your key will NOT be shown as you paste it. Press Enter when done.\n");

  const key = (await promptHidden(`${VAR}: `)).trim().replace(/^["']|["']$/g, "");

  if (!key) {
    console.error("Nothing entered — backend/.env was not changed.");
    process.exit(1);
  }

  // A wrong-looking key is worth catching here rather than as a 503 in the
  // middle of a demo. Warn, don't block: gateways issue other formats.
  const expectedPrefix = VAR === "OPENAI_API_KEY" ? "sk-" : "sk-ant-";
  if (!key.startsWith(expectedPrefix)) {
    console.warn(
      `\nWarning: ${VAR} usually starts with "${expectedPrefix}". Saving it anyway — ` +
        "re-run this script if it turns out to be wrong."
    );
  }

  const updated = upsert(fs.readFileSync(ENV_FILE, "utf8"), VAR, key);
  fs.writeFileSync(ENV_FILE, updated);

  // Length only. Never the value, and never a prefix of it.
  console.log(`\nSaved. ${VAR} is now set in backend/.env (${key.length} characters).`);
  console.log("backend/.env is git-ignored, so this cannot be committed.");
  console.log("\nNext:  npm run demo -- --reset");
}

main().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
