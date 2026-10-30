const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFolderDocuments, MAX_FILES } = require("../src/folder.cjs");

test("lê só documentos do primeiro nível da pasta escolhida", () => {
  const dir = mkdtempSync(join(tmpdir(), "jurix-pasta-"));
  try {
    writeFileSync(join(dir, "peticao.docx"), "docx");
    writeFileSync(join(dir, "Contrato.PDF"), "pdf");
    writeFileSync(join(dir, "foto.jpg"), "img");
    writeFileSync(join(dir, "programa.exe"), "exe");
    writeFileSync(join(dir, ".oculto.txt"), "x");
    writeFileSync(join(dir, "~$peticao.docx"), "lock");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "dentro.pdf"), "pdf");
    const r = readFolderDocuments(dir);
    assert.deepEqual(r.files.map((f) => f.name), ["Contrato.PDF", "peticao.docx"]);
    assert.equal(String(r.files[0].data), "pdf");
    assert.deepEqual(r.skipped.sort(), ["foto.jpg", "programa.exe", "sub"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("para no limite de arquivos", () => {
  const dir = mkdtempSync(join(tmpdir(), "jurix-pasta-"));
  try {
    for (let i = 0; i < MAX_FILES + 2; i++) writeFileSync(join(dir, `doc${String(i).padStart(2, "0")}.txt`), "t");
    const r = readFolderDocuments(dir);
    assert.equal(r.files.length, MAX_FILES);
    assert.equal(r.skipped.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
