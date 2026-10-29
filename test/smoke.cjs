// Teste manual com os CLIs reais logados nesta máquina: `npm run smoke [motor]`.
// Roda uma tarefa de texto e uma rodada completa de ferramenta (formato do Lex).
const { ENGINES, findEngine, runJob } = require("../src/engines.cjs");

const system = { role: "system", content: "Você é o Lex, assistente jurídico. Responda em português, breve." };
const tools = [
  {
    type: "function",
    function: {
      name: "buscar_prazos",
      description: "Lista os prazos pendentes do processo aberto.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

async function smoke(engine, path) {
  const t0 = Date.now();
  const { reply: text, quota } = await runJob(engine, path, {
    messages: [system, { role: "user", content: "Em uma frase: o que é contestação?" }],
  });
  const t1 = Date.now();

  const ask = { role: "user", content: "Quais são os prazos deste processo?" };
  const { reply: first } = await runJob(engine, path, { messages: [system, ask], tools });
  const call = first.toolCalls?.[0];
  let final = null;
  if (call) {
    ({ reply: final } = await runJob(engine, path, {
      messages: [
        system,
        ask,
        { role: "assistant", content: null, tool_calls: first.toolCalls },
        {
          role: "tool",
          tool_call_id: call.id,
          content: '[{"tipo":"Contestação","vence":"2026-11-10"},{"tipo":"Audiência","data":"2026-11-18 14h"}]',
        },
      ],
      tools,
    }));
  }
  const t2 = Date.now();
  console.log(`\n=== ${engine} ===`);
  console.log(`cota: ${quota ? JSON.stringify(quota.windows) : "não informada"}`);
  console.log(`texto (${((t1 - t0) / 1000).toFixed(1)}s): ${text.content.slice(0, 160)}`);
  console.log(`pediu ferramenta: ${call ? call.function.name : "NÃO"}`);
  console.log(`resposta final (${((t2 - t1) / 1000).toFixed(1)}s): ${(final?.content ?? first.content).slice(0, 220)}`);
}

(async () => {
  const only = process.argv[2];
  for (const engine of only ? [only] : ENGINES) {
    const path = findEngine(engine);
    if (!path) {
      console.log(`\n=== ${engine} === não instalado`);
      continue;
    }
    await smoke(engine, path).catch((e) => console.log(`\n=== ${engine} === ERRO: ${e.message}`));
  }
})();
