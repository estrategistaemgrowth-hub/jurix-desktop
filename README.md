# Jurix Desktop

O [Jurix](https://jurix.work) no computador (Windows e Mac), com a IA da assinatura do próprio usuário: Claude (Claude Code), ChatGPT (Codex) ou Gemini (Antigravity).

O app abre o mesmo Jurix da nuvem. Login, telas, permissões e assinatura são os do site; tudo o que é feito no desktop fica salvo na nuvem. O que muda é a IA: quando o escritório escolhe "IA local de cada advogado", as respostas de IA do usuário logado são geradas pelo CLI instalado na máquina dele, sem consumir a API.

## Baixar

- Windows: [Jurix-Setup.exe](https://github.com/estrategistaemgrowth-hub/jurix-desktop/releases/latest/download/Jurix-Setup.exe)
- Mac: [Jurix.dmg](https://github.com/estrategistaemgrowth-hub/jurix-desktop/releases/latest/download/Jurix.dmg)

O app ainda não tem assinatura digital. No Windows, na tela "O Windows protegeu o computador", clique em **Mais informações > Executar assim mesmo**. No Mac, na primeira vez, clique com o botão direito no Jurix em Aplicativos e escolha **Abrir**.

## Desenvolvimento

```bash
npm install
npm start          # abre o app
npm test           # testes de unidade
npm run smoke      # testa os CLIs de IA instalados nesta máquina
npm run dist:win   # gera dist/Jurix-Setup.exe
```

Nova versão: aumente `version` no `package.json` e crie a tag `vX.Y.Z`. O GitHub Actions gera o `.exe` e o `.dmg` e publica no Release; os apps instalados no Windows se atualizam sozinhos.

O código-fonte principal fica na pasta `desktop/` do repositório do Jurix; este repositório é o espelho público usado para gerar e distribuir os instaladores.
