/**
 * 候选放行的必需门选择与执行回执。
 * 建立时间：2026-10-21；状态：active。
 * 边界：规则只从当前已登记的 Git 基线读取；执行回执不替代独立语义审查。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type Candidate = {
  sha: string;
  tree: string;
  base_sha: string;
  test_matrix_ref?: string;
  required_gates?: string[];
  gate_policy_commit?: string;
  quality_gate?: Record<string, string>;
  gate_environment_sha256?: string;
  gate_inputs?: Record<string, string>;
  gate_environment?: Row;
  gate_receipts?: Record<string, { path: string; sha256: string }>;
};
type Plan = {
  ruleCommit: string;
  policySha256: string;
  candidateSha: string;
  candidateTree: string;
  baseSha: string;
  changedPaths: string[];
  gates: Gate[];
};
const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("门禁对象格式无效");
  return value as Row;
};
const candidateValue = (value: unknown) => row(value) as Candidate;
type Gate = { id: string; command: string[]; paths?: string[] };
const MATRIX = "knowledge/test-impact-matrix.md";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const full = (v: unknown) => typeof v === "string" && /^[a-f0-9]{40}$/u.test(v);
const sha256 = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);

/** 识别发布冻结、READY 或交接声明，普通编辑不触发发布门。 @since unreleased */
export function releaseClaim(state: Row): boolean {
  return (state.candidate && row(state.candidate).release_frozen) === true || (state.iteration && row(state.iteration).status) === "READY_WAIT_OWNER"
    || (state.candidate && row(state.candidate).status) === "READY_FOR_RELEASE_WAIT_OWNER";
}

/** 从已登记规则及真实候选差分生成适用门；身份或策略缺失时拒绝。 @since unreleased */
export function gatePlan(root: string, trustedState: Row, value: unknown): Plan {
  const candidate = candidateValue(value);
  const baseline = row(trustedState.rule_baseline).commit;
  if (typeof baseline !== "string" || !/^[a-f0-9]{6,40}$/u.test(baseline)) throw new Error("必需门缺少已登记规则基线");
  const ruleCommit = git(root, ["rev-parse", "--verify", `${baseline}^{commit}`]);
  const source = git(root, ["show", `${ruleCommit}:${MATRIX}`]);
  const matches = [...source.matchAll(/<!-- control-plane-gate-policy -->\s*```json\s*([\s\S]*?)```/gu)];
  if (matches.length !== 1) throw new Error("已登记规则基线尚无机器门禁策略；须完成规则接入，不能使用候选自改策略放行");
  const policy = JSON.parse(matches[0][1]) as { schema: number; release: Gate[]; impact: Gate[] };
  if (policy.schema !== 1 || !Array.isArray(policy.release) || !policy.release.length || !Array.isArray(policy.impact)) throw new Error("门禁策略格式无效");
  if (!full(candidate.sha) || !full(candidate.tree) || !full(candidate.base_sha)
    || git(root, ["rev-parse", "--verify", `${candidate.sha}^{tree}`]) !== candidate.tree) throw new Error("候选及比较基线必须是可核验完整SHA/tree");
  // base_sha须来自已登记范围，不能靠候选自选空diff漏掉专项。
  const scopeBase = row(row(trustedState.scope).baseline).commit;
  if (typeof scopeBase !== "string" || !/^[a-f0-9]{6,40}$/u.test(scopeBase)
    || git(root, ["rev-parse", "--verify", `${scopeBase}^{commit}`]) !== candidate.base_sha) throw new Error("候选差分基线与已登记范围不一致");
  git(root, ["merge-base", "--is-ancestor", candidate.base_sha, candidate.sha]);
  const changedPaths = git(root, ["diff", "--name-only", "--no-renames", candidate.base_sha, candidate.sha]).split("\n").filter(Boolean);
  const all: Gate[] = [...policy.release, ...policy.impact];
  if (new Set(all.map(g => g.id)).size !== all.length || all.some(g => !/^[a-z][a-z0-9_]*$/u.test(g.id)
    || !Array.isArray(g.command) || !g.command.length || g.command.some(v => typeof v !== "string" || !v)
    || (g.paths !== undefined && (!Array.isArray(g.paths) || g.paths.some(p => typeof p !== "string" || !p))))) throw new Error("门禁定义无效或重复");
  const gates = all.filter(g => policy.release.includes(g) || g.paths?.some(prefix => changedPaths.some(p => p.startsWith(prefix)))
    || (Array.isArray(candidate.required_gates) && candidate.required_gates.includes(g.id)));
  return { ruleCommit, policySha256: hash(matches[0][1]), candidateSha: candidate.sha, candidateTree: candidate.tree,
    baseSha: candidate.base_sha, changedPaths, gates };
}

function commandFor(gate: Gate, candidate: Candidate): string[] {
  return gate.command.map(arg => {
    if (arg !== "$snapshot") return arg;
    if (typeof candidate.gate_inputs?.snapshot !== "string" || !candidate.gate_inputs.snapshot) throw new Error("有状态门缺少快照路径");
    return candidate.gate_inputs.snapshot;
  });
}
async function inputs(root: string, candidate: Candidate): Promise<Row> {
  const result: Row = {};
  for (const [name, file] of Object.entries(candidate.gate_inputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof file !== "string") throw new Error("门输入须为文件路径");
    result[name] = hash(await fs.readFile(path.resolve(root, file)));
  }
  return result;
}

/** 核验实际回执、日志、候选和输入；手填 PASS 不能代替执行证明。 @since unreleased */
export async function verifyReleaseGates(root: string, trustedState: Row, target: Row): Promise<void> {
  const c = candidateValue(target.candidate);
  if (!Array.isArray(target.blockers) || target.blockers.some(b => !["CLOSED", "RESOLVED"].includes(String(row(b).status)))) throw new Error("候选仍有未关闭阻断项");
  const plan = gatePlan(root, trustedState, c);
  const declared = c.required_gates;
  if (!Array.isArray(declared) || new Set(declared).size !== declared.length
    || plan.gates.some((g: Gate) => !declared.includes(g.id))) throw new Error("候选漏列策略必需门");
  if (declared.some((id: string) => !plan.gates.some((g: Gate) => g.id === id))) throw new Error("附加门须先登记到已审定策略，不能使用无定义的PASS");
  if (c.test_matrix_ref?.split("#")[0] !== MATRIX || c.gate_policy_commit !== plan.ruleCommit) throw new Error("门禁规则引用或完整版本不匹配");
  if (!sha256(c.gate_environment_sha256)) throw new Error("候选未固定门禁环境摘要");
  const inputHashes = await inputs(root, c);
  for (const gate of plan.gates as Gate[]) {
    const ref = c.gate_receipts?.[gate.id];
    if (c.quality_gate?.[gate.id] !== "PASS" || !ref || !sha256(ref.sha256) || typeof ref.path !== "string") throw new Error(`必需验证门${gate.id}未通过或缺执行回执`);
    const bytes = await fs.readFile(path.resolve(root, ref.path));
    if (hash(bytes) !== ref.sha256) throw new Error(`门${gate.id}回执摘要不匹配`);
    const receipt: Row = row(JSON.parse(bytes.toString("utf8")));
    if (receipt.schema !== 1 || receipt.producer !== "control-plane:run-gate" || receipt.gate !== gate.id
      || receipt.status !== "PASS" || receipt.exitCode !== 0 || receipt.signal !== null
      || receipt.candidateSha !== c.sha || receipt.candidateTree !== c.tree || receipt.baseSha !== c.base_sha
      || receipt.ruleCommit !== plan.ruleCommit || receipt.policySha256 !== plan.policySha256
      || hash(JSON.stringify(receipt.environment)) !== c.gate_environment_sha256
      || JSON.stringify(receipt.inputHashes) !== JSON.stringify(inputHashes)
      || JSON.stringify(receipt.command) !== JSON.stringify(commandFor(gate, c))
      || !Number.isFinite(Date.parse(String(receipt.startedAt))) || !Number.isFinite(Date.parse(String(receipt.finishedAt)))
      || Date.parse(String(receipt.finishedAt)) < Date.parse(String(receipt.startedAt))) throw new Error(`门${gate.id}执行结果、候选或环境不匹配`);
    if (typeof receipt.logPath !== "string" || !sha256(receipt.logSha256)
      || hash(await fs.readFile(path.resolve(root, receipt.logPath))) !== receipt.logSha256) throw new Error(`门${gate.id}执行日志缺失或摘要不匹配`);
  }
}

/** 执行策略中的一项现有命令，生成不可覆盖的本地回执和日志。 @since unreleased */
export async function runGate(root: string, trustedState: Row, request: Row): Promise<{ status: string; path: string; sha256: string; environmentSha256: string }> {
  const c = candidateValue(trustedState.candidate);
  const plan = gatePlan(root, trustedState, c);
  const gate = plan.gates.find((g: Gate) => g.id === request.gate) as Gate | undefined;
  if (!gate) throw new Error("门不在当前适用策略中");
  const assertSource = () => {
    if (git(root, ["rev-parse", "HEAD"]) !== c.sha || git(root, ["diff", "--name-only", "HEAD"]).split("\n").filter(p => p
      && p !== "coordination/current.json" && !/^coordination\/versions\/[^/]+\/(events.jsonl|terminal.json)$/u.test(p)).length
      || git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").some(p => p && !p.startsWith("artifacts/local/"))) {
      throw new Error("执行门须在固定候选的干净源码工作区，不能给未提交代码发候选回执");
    }
  };
  assertSource();
  if (typeof request.output !== "string" || !request.output.startsWith("artifacts/local/") || request.output.includes("..")) throw new Error("回执须写入artifacts/local下的新文件");
  const output = path.resolve(root, request.output), logPath = `${request.output}.log`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  // 独占创建，失败重跑不能覆盖先前证据。
  const receiptFile = await fs.open(output, "wx");
  try {
    const command = commandFor(gate, c), inputHashes = await inputs(root, c);
    const childEnvironment = { ...process.env, FOR_NOW_GATE_SNAPSHOT: c.gate_inputs?.snapshot ?? "" };
    const environment = { platform: process.platform, arch: process.arch, node: process.version,
      processEnvironmentSha256: hash(JSON.stringify(Object.entries(childEnvironment).sort(([a], [b]) => a.localeCompare(b)))),
      declaredContext: c.gate_environment ?? {} };
    const startedAt = new Date().toISOString();
    let exitCode: number | null = null, signal: NodeJS.Signals | null = null;
    const log = await fs.open(path.resolve(root, logPath), "wx");
    try {
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ["ignore", log.fd, log.fd], shell: false,
          env: childEnvironment });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      exitCode = outcome.code;
      signal = outcome.signal;
    } finally { await log.close(); }
    assertSource();
    if (JSON.stringify(await inputs(root, c)) !== JSON.stringify(inputHashes)) throw new Error("门运行期间输入已变化");
    const receipt = { schema: 1, producer: "control-plane:run-gate", gate: gate.id,
      candidateSha: c.sha, candidateTree: c.tree, baseSha: c.base_sha, ruleCommit: plan.ruleCommit,
      policySha256: plan.policySha256, command, environment, inputHashes, startedAt, finishedAt: new Date().toISOString(),
      exitCode, signal, status: exitCode === 0 && signal === null ? "PASS" : "FAIL", logPath,
      logSha256: hash(await fs.readFile(path.resolve(root, logPath))) };
    const bytes = JSON.stringify(receipt, null, 2) + "\n";
    await receiptFile.writeFile(bytes);
    return { status: receipt.status, path: request.output, sha256: hash(bytes), environmentSha256: hash(JSON.stringify(environment)) };
  } finally { await receiptFile.close(); }
}
