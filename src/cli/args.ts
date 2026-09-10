export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = {
  ls: "list",
  accept: "accept",
  reject: "reject",
  continue: "start",
  "?": "help",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  if (argv[0] === "campaign") i = 1;
  let cmd = "help";
  if (argv[i] && !argv[i]!.startsWith("-")) {
    cmd = argv[i]!;
    i += 1;
  }
  if (/^https?:\/\//i.test(cmd)) {
    flags.url = cmd;
    cmd = "run";
  }
  cmd = ALIASES[cmd] ?? cmd;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h" || a === "--?") flags.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function resolveCampaignId(
  flags: Record<string, string | boolean>,
  positional: string[],
  campaigns: { id: string; state: string }[],
): string {
  const fromFlag = flagString(flags, "id");
  if (fromFlag) return fromFlag;
  if (positional[0]) return positional[0];
  if (campaigns.length === 1) return campaigns[0]!.id;
  if (campaigns.length === 0) throw new Error("no campaigns here. rionext run --url <target>");
  const lines = campaigns.map((c) => `  ${c.id}  ${c.state}`).join("\n");
  throw new Error(`multiple campaigns; pass an id:\n${lines}`);
}

export const HELP = `RioNext CLI

  rionext ?                  this guide
  rionext ? provider         provider catalog and keys
  rionext ? kali             Kali image and clones

Windows: .\\rionext.cmd   Linux/macOS: ./rionext or npx rionext
Data dir: .rionext  (override --data-dir or RIONEXT_DATA)
Only one campaign in the dir? omit [id].
CLI reads dist/; after TypeScript changes run npx tsc -p tsconfig.json.

Start a live Kali flag campaign (solver slot, no spec file):

  rionext run --url http://authorized-target.example/
  rionext http://authorized-target.example/

Or a local CTF challenge (file or directory):

  rionext run --input ./crackme.elf
  rionext run --input ./pwn-dir --endpoint tcp://host:31337
  rionext run --input ./cipher.txt --kind crypto
  rionext run --input ./challenge --hint "task description text"

  --input copies attachments into the workspace with a SHA-256 manifest,
  classifies the challenge (reverse/pwn/misc/crypto/generic) without
  executing it, and seeds a ready step. --kind overrides classification.
  --input is mutually exclusive with --url and --spec.

Or a spec file:

  rionext run --spec profiles/demo-lab.json
  rionext run --spec path\to\spec.json --progress-ms 60000

run --url/--input use the solver slot. Same URL or input path again resumes that campaign id.

Campaign:

  rionext list
  rionext status [id]
  rionext start [id]         resume Decide/Execute
  rionext pause|resume|cancel [id]
  rionext accept [id]        human: submitted flag is correct
  rionext reject [id] --text <why> [--continue]
  rionext hint [id] --text <hint>
  rionext revise-budget [id] --max-calls N --max-tokens N
  rionext explain-step [id] --step <step_id>

Inspect:

  rionext facts|steps|findings|events|operations|report [id]
  rionext observations|invocations|coverage|goals|artifacts [id]

Provider (keys never printed; see rionext ? provider):

  rionext provider list|show|add|set|key|rm|model|test|slots|ui

Web UI (full workbench; campaigns run inside the ui process):

  rionext ui [--port 7780]

Kali (see rionext ? kali):

  rionext health
  rionext kali status|pull|build|protect|smoke

Flags on run/start:

  --progress-ms 300000       0 turns the 5 min progress log off
  --max-cycles 1000          controller cycles, not model calls
  --max-execute-turns 72     one Execute fragment defaults to 72 model turns
  --max-tool-calls 144       and 144 tool calls
  --finalization             Execute Finalize is on by default
  --no-finalization          or RIONEXT_FINALIZATION=0 turns it off
  --finalization or RIONEXT_FINALIZATION=1 still force it on
  --json

Budget defaults: 3000 calls, 30_000_000 tokens, 1000 controller cycles.
Flag claims stop at awaiting_verify until rionext accept.
More detail: docs/ops.md
`;
