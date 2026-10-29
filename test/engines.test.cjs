const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, parseToolReply } = require("../src/engines.cjs");

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
