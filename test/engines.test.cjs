const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  CONTEXT_PREFIX,
  buildPrompt,
  parseToolReply,
  isQuick,
  claudeQuota,
  codexQuota,
  LIMIT_RE,
} = require("../src/engines.cjs");

const tools = [
  {
    type: "function",
    function: {
      name: "buscar_prazos",
      description: "Prazos do processo",
      parameters: { type: "object", properties: {} },
    },
  },
];

test("separa system e conversa, inclusive rodadas de ferramenta", () => {
  const built = buildPrompt({
    messages: [
      { role: "system", content: "MODO OPERACIONAL" },
      { role: "system", content: "Você é o Lex." },
      { role: "user", content: "Quais os prazos?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "buscar_prazos", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: '[{"prazo":"18/11/2026"}]' },
    ],
    tools,
  });
  assert.ok(built.system.startsWith("MODO OPERACIONAL\n\nVocê é o Lex."));
  assert.match(built.system, /buscar_prazos/);
  assert.match(built.prompt, /\[USUÁRIO\]\nQuais os prazos\?/);
  assert.match(built.prompt, /buscar_prazos\(\{\}\) \[id c1\]/);
  assert.match(built.prompt, /\[RESULTADO DA FERRAMENTA c1\]/);
  assert.equal(built.hasTools, true);
});

test("contexto da pergunta vai na mensagem; o system fica fixo (Claude pré-aberto)", () => {
  const context = `${CONTEXT_PREFIX}: hoje é 30/10/2026.`;
  const built = buildPrompt({
    messages: [
      { role: "system", content: "Você é o Jurix IA." },
      { role: "system", content: context },
      { role: "user", content: "Oi?" },
    ],
  });
  assert.equal(built.system, "Você é o Jurix IA.");
  assert.ok(built.prompt.startsWith(context));
  assert.equal(built.warmable, true);
  assert.equal(buildPrompt({ messages: [{ role: "user", content: "x" }] }).warmable, false);
});

test("sem ferramentas não injeta o protocolo JSON", () => {
  const built = buildPrompt({ messages: [{ role: "user", content: "Resuma." }] });
  assert.equal(built.system, "");
  assert.equal(built.hasTools, false);
});

test("lê pedido de ferramenta e converte para o formato OpenAI", () => {
  const reply = parseToolReply(
    'Claro.\n{"tool_calls":[{"name":"buscar_prazos","arguments":{"caso":"x"}},{"semNome":1}]}',
  );
  assert.equal(reply.content, "");
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].function.name, "buscar_prazos");
  assert.equal(reply.toolCalls[0].function.arguments, '{"caso":"x"}');
  assert.match(reply.toolCalls[0].id, /^local_/);
});

test("resposta final em JSON ou em texto solto", () => {
  assert.deepEqual(parseToolReply('{"content":"Prazo em 18/11."}'), { content: "Prazo em 18/11." });
  assert.deepEqual(parseToolReply("  Prazo em 18/11.  "), { content: "Prazo em 18/11." });
});

test("cota do Claude: janelas de 5 horas e semanal do rate_limit_event", () => {
  const quota = claudeQuota({
    type: "rate_limit_event",
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: 0.41, resetsAt: 1793295600 },
        seven_day: { utilization: 0.586, resetsAt: 1793365200 },
      },
    },
  });
  assert.deepEqual(quota.windows, [
    { label: "5 horas", usedPercent: 41, resetsAt: 1793295600 },
    { label: "semana", usedPercent: 59, resetsAt: 1793365200 },
  ]);
  assert.equal(claudeQuota(undefined), null);
});

test("cota do Codex: rate_limits mais recente da pasta de sessões mais nova", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const write = (day, name, lines) => {
    const dir = join(root, "2026", "10", day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n"));
  };
  const limits = (used) => ({
    payload: {
      type: "token_count",
      rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: 1793800408 } },
    },
  });
  write("27", "rollout-a.jsonl", [limits(90)]);
  write("28", "rollout-b.jsonl", [limits(5), limits(11), { payload: { type: "agent_message" } }]);
  try {
    assert.deepEqual(codexQuota(root).windows, [
      { label: "semana", usedPercent: 11, resetsAt: 1793800408 },
    ]);
    assert.equal(codexQuota(join(root, "nao-existe")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("modo rápido só em conversa curta, nunca em peça ou minuta", () => {
  const ask = (content) => ({ messages: [{ role: "system", content: "x" }, { role: "user", content }] });
  assert.equal(isQuick(ask("Olá, tudo bem?")), true);
  assert.equal(isQuick(ask("Quais prazos vencem hoje?")), true);
  assert.equal(isQuick(ask("Redija uma contestação para o processo 123")), false);
  assert.equal(isQuick(ask("a".repeat(401))), false);
  assert.equal(isQuick({ messages: [] }), false);
});

test("reconhece erro de limite da assinatura", () => {
  assert.match("Claude AI usage limit reached|1793295600", LIMIT_RE);
  assert.match("stream error: 429 Too Many Requests", LIMIT_RE);
  assert.doesNotMatch("spawn ENOENT", LIMIT_RE);
});
