// "Anexar pasta" do Jurix IA: lê só os documentos da pasta que o próprio advogado
// escolheu na janela do sistema. Só leitura, só o primeiro nível (subpastas não
// entram), só formatos de documento e com limite; nada é alterado no disco.
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { basename, join } = require("node:path");

const DOCUMENT_RE = /\.(pdf|docx|txt|md|csv|rtf)$/i; // os mesmos que o anexo do chat lê
const MAX_FILES = 30;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/** { folder, files: [{ name, data }], skipped: [nomes] } */
function readFolderDocuments(dir) {
  const files = [];
  const skipped = [];
  let total = 0;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  for (const entry of entries) {
    // Ocultos e temporários do Word (~$arquivo.docx, aberto em outra janela): nem aparecem.
    if (/^(\.|~\$)/.test(entry.name)) continue;
    // isFile() é falso para atalho/link simbólico: não segue para fora da pasta.
    if (!entry.isFile() || !DOCUMENT_RE.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const full = join(dir, entry.name);
    const size = statSync(full).size;
    if (files.length >= MAX_FILES || size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
      skipped.push(entry.name);
      continue;
    }
    files.push({ name: entry.name, data: readFileSync(full) });
    total += size;
  }
  return { folder: basename(dir), files, skipped };
}

module.exports = { readFolderDocuments, MAX_FILES };
