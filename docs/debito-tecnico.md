# Débito técnico conhecido — surf-agent-skill

- **Versão de referência**: `8.0.1` (`package.json`)
- **Data**: 2026-08-30
- **Base**: `0f7126e` (fim da auditoria adversarial de 2026-08-29/30, 5 ondas, 33 sub-tarefas)
- **Como este arquivo foi verificado**: `npm test` — exit 0, `GATE GREEN`, 7 suítes. Todo item marcado
  como vivo abaixo foi **confirmado nesta base**, pela linha correspondente da saída da suíte ou por
  leitura do fonte. Itens que o registro da execução listava como abertos e que já haviam sido
  fechados por uma onda posterior **não** estão aqui (a lista deles está no fim, em
  [§6](#6-o-que-o-registro-da-execução-listava-como-aberto-e-já-está-fechado)).

Este arquivo **não** é o relatório da auditoria (isso é o `EXPLAINER.html`). É a lista do trabalho
que sobrou, com o motivo de cada exclusão, para quem for mexer no código depois.

## Como ler

- **onde** — arquivo:linha, e o id do `bug()` na suíte adversarial quando existe. Os ids são os que
  `npm run test:adversarial` imprime; procure por eles na saída.
- **por que ficou de fora** — um revisor de plano triou os 201 achados da onda 1 e registrou o motivo
  de cada exclusão. As cinco categorias que ele usou:

  | sigla | significado |
  |---|---|
  | `IMPACTO` | baixo impacto medido; o custo de errar é uma requisição ou uma linha de texto |
  | `REGRESSÃO` | a correção óbvia reabre um defeito já fechado, ou aumenta um dano maior |
  | `ASSINATURA` | a correção certa muda a assinatura de uma função exportada (proibido na execução) |
  | `REDESENHO` | exige mudar um contrato de API/parada, não uma linha |
  | `DESIGN` | é decisão deliberada — ver [§2](#2-os-que-não-são-bugs) |

- Onde um agente já deixou o caminho pronto, a coluna **correção** repete o que ele escreveu.

---

## 1. Débito por risco

### 1.1 — Corrompe estado persistido

O `keys.json` e o `ratelimit.json` sobrevivem ao processo. Um erro aqui não é uma execução ruim, é
uma máquina que fica ruim.

| id | onde | o que quebra | por que ficou de fora | correção |
|---|---|---|---|---|
| `P1` (gate-state) | `src/lib/state.mjs:127` e `:101` | Um veredito de validação com `at` no **futuro** nunca expira: `Date.now()-at > TTL` é negativo, então o portão confia na chave para sempre. Uma revogação nunca é re-sondada. | `REGRESSÃO` — corrigir em `normalizeProvider` acende `gate-state.mjs:281`; ver [§3](#3-armadilhas-na-régua) | comparar idade **unilateralmente** (`at` no futuro = tratar como agora), como `ratelimit.mjs` já faz depois da onda 2 |
| `S2` (gate-state) | `src/lib/state.mjs:127` (`> TTL`) vs `:101` (`< TTL`) | As duas comparações de TTL discordam **exatamente** em TTL: `getValidation` diz hit e `normalizeProvider` poda. A mesma entrada está viva em memória e morta em disco. | `IMPACTO` — janela de 1 ms | uma constante e um operador; é a irmã do `P1` e sai no mesmo commit |
| `S5` (gate-state) | `src/lib/state.mjs:86` e `:159` | Um registro de burn **sem `at`** (ou com `at` impossível de parsear) é admitido em `:86`, e `:159` lê o `NaN` como "reset me": a chave se **desqueima sozinha** no próximo load. | `IMPACTO` — só acontece com `keys.json` editado à mão | rejeitar a entrada no `:86` em vez de normalizar para `NaN` |
| `M2` (lib-install) | `src/env.mjs:145` | `new Map(src.keys.map((k,i)=>[k,i]))` guarda só a **última** ocorrência: uma chave duplicada no `keys.json` perde o burn e uma chave que a CLI provou morta volta limpa. | `IMPACTO` | mapear valor→**lista** de índices, ou deduplicar as chaves na escrita |
| `H10` (lib-install) | `src/lib/harness-install.mjs:15`, `src/lib/state.mjs:31-35` | `CONFIG_DIR`, `KEYS_FILE`, `LOCK_FILE`, `CACHE_DIR` e `HARNESS_DIRS` são `export const` no **topo do módulo**: congelam no primeiro import. Qualquer processo que ajuste `HOME` depois do start — container, `sudo -E` parcial, harness que seta `HOME` tarde, CI — lê e escreve no diretório errado sem avisar. | `ASSINATURA` — vira função ou getter, e cinco módulos importam a const | virar getter memoizado com invalidação. **Esta é a causa raiz apurada dos 4 buckets de chave falsa que apareceram no `~/.cache/surf/ratelimit.json` real durante a auditoria** — os testes isolavam certo; o isolamento é ordem-dependente por construção. Os buckets são inertes (chaves que não existem) e foram deixados no lugar de propósito. |

### 1.2 — Engana o usuário ou o agente

Um veredito ou um relatório que afirma mais do que sabe. É o pior tipo de defeito num pacote cuja
única entrega é evidência citada.

| id | onde | o que quebra | por que ficou de fora | correção |
|---|---|---|---|---|
| `P2` (gate-state) | `src/lib/preflight.mjs:178` | `resolveGate({allowLive:false})` devolve `GATE.READY` literal para uma chave **nunca validada** — presença é reportada com a mesma palavra que prova. `assertProviderReady` deixa passar o hard stop. | `REDESENHO` — precisa de um veredito novo (`PRESENT_UNPROVEN`) e de todo consumidor saber lê-lo | é o item que **bloqueia dois outros**: sem ele, `cmdGate` não pode ganhar `--offline` (o agente da onda 2 recusou expor a flag por isso) e o portão da FASE 0 da skill não pode ser 100% offline |
| `G4` (lib-install) | `src/lib/api/search.mjs:99-108` | `searchParallel()` **resolve** com todos os batches falhos quando não há chave — nunca rejeita. É o "0 sources but exit 0" que `preflight.mjs:3-4` diz ter matado: o invariante da v8 sobrevive no caminho CLI e **não** no fan-out de biblioteca. | `ASSINATURA` — rejeitar muda o contrato de retorno de uma função exportada | o teste já aceita as duas leituras (`settle()`, CASO D da onda 2): se resolver, `summary.failed===2`; se rejeitar, `BraveKeyMissing` + 78. O contrato dos dois já existe em `preflight.mjs:46-54` |
| `E1`/`E2` (lib-install) | `src/lib/api/search.mjs:48` e `:100` | `buildArgs()` roda **dentro** do try por item, então um enum inválido vira falha-por-item em vez de erro de uso. O chamador recebe "a busca falhou" quando o que houve foi um argumento errado. | `ASSINATURA` | mover `buildArgs()` para fora do laço, antes do primeiro fetch |
| `BUG-14` (loop-frontier) | `src/lib/ai/ledger.mjs:27-29` e `:100-106` | Uma URL **relativa** cai fora do `catch` e é guardada verbatim, sem host. Duas páginas diferentes em dois sites que compartilham o `/path` viram **uma** fonte, citadas como `[1]`, e o título da segunda é descartado. | `IMPACTO` (avaliado pelo revisor) — mas é o item de maior consequência editorial desta seção | resolver a relativa contra o host do resultado antes de canonicalizar, ou recusar a linha |
| `BUG-13` (loop-frontier) | `src/lib/ai/ledger.mjs:13-14` | Remover `source`/`ref` da query string funde páginas genuinamente diferentes numa fonte só. | `REGRESSÃO` — a lista de parâmetros de tracking é a mesma que faz o dedup funcionar | tirar `source`/`ref` da lista, ou só removê-los quando o resto da URL já colidir |
| `BUG-19` (loop-frontier) | `src/lib/ai/ledger.mjs:188-191` | Quando `maxChars` é menor que o **primeiro** bloco, o digest quebra antes de empurrar qualquer coisa: o modelo recebe só `(evidence truncated…)` — zero evidência, e sintetiza mesmo assim. | `IMPACTO` — o teto default (130 000) é muito maior que um bloco | garantir pelo menos um bloco, truncando o bloco em vez do laço |
| `#31` (flags-cli) | `src/lib/ai/orchestrator.mjs:578-585` (`runOneSearch`) vs `bin/surf-research-skill.mjs:112-125` | No caminho **surf-ai** só `query`, `mode` e `max` chegam à Brave. `--domains`, `--exclude`, `--time`, `--country`, `--safesearch`, `--goggles` e `--result-filter` são aceitos e **descartados em silêncio**, enquanto o `--help` diz "all of these now actually reach Brave". | `ASSINATURA` (decisão **D5** do orquestrador) — a correção certa muda a assinatura no meio de `orchestrator.mjs` | propagar `searchFlags` até `runOneSearch`. A referência de linha impressa pela suíte (`:515-521`) está **defasada** — o lugar real é `runOneSearch` |
| — (achado da onda 2.11) | `src/lib/ai/ledger.mjs:209` | `digest()` interpola `r.title` e `r.url` **crus** no prompt de síntese. Um título vindo da Brave contendo `###` forja um cabeçalho de bloco de evidência dentro do prompt do LLM. | não triado (achado depois da triagem) | escapar/cercar o título como o `stripHtml` já faz com marcação — o sanitizador de HTML foi endurecido nas ondas 2/3/4, o **envelope do prompt** não |
| `B-08` (auditoria-prompts) | `references/failure-modes.md:95-98` | Sob `teto-de-sessão`, o orquestrador roda T4, T5 e T6 **inline**. O T4 é definido como "revisor adversarial com ZERO contexto" e o T5 existe para pegar o que o orquestrador não viu: rodados pelo agente que tomou todas as decisões de fechamento, os dois perdem a propriedade que os torna úteis. A degradação está **declarada**, mas declarada como se fosse equivalente. | fora do escopo fechado pela onda 2.15 (que fechou B-01..B-06, B-07 parcial e B-09) | a redação já está pronta em `docs/auditoria-prompts.md`, seção B-08: rebaixar toda afirmação um nível de confiança e **proibir** que o veredito inline feche dúvida que estivesse ABERTA |
| `B-07` (parcial) | `SKILL.md:311-316` | A **TRAVA DA INFERIDA** entrou (proíbe INFERIDA quando a resposta tem número, versão, preço, data, limite ou nome de API), mas o **teto de 20%** proposto não. `grep 20% SKILL.md` = vazio. `RESPONDIDA-INFERIDA` segue sem limite superior. | o agente da onda 2.15 declarou a omissão: "NÃO implementou o teto de 20% — G segue sem limite superior" | uma linha na identidade contábil de `SKILL.md:259` |
| `R4` — letra morta | `SKILL.md:130`, `:145`, `:441` | A **barreira entre rajadas** é imposta escrevendo `run_in_background: false` em toda chamada `Agent`. O agente da onda 2.15 verificou: **`run_in_background` não existe no schema da ferramenta `Agent`** desta sessão. A regra que impede duas rajadas de se sobreporem depende de um parâmetro que o harness ignora — e um parâmetro ignorado não produz erro, produz silêncio. | achado de harness, fora do escopo de código da onda | ou a barreira passa a ser imposta pelo **fluxo** (o orquestrador só emite a rajada N+1 depois de ler os N handoffs em disco), ou a regra precisa dizer que é convenção, não trava. Hoje ela se anuncia como trava |
| — (honestidade da onda 2.15) | `SKILL.md` (portões G2/G3, barreira da R5) | O que continua **exortação e não regra**, declarado pelo próprio agente que fechou os outros cinco caminhos: `G2` ("muda uma parte CONCRETA do entregável") segue sendo julgamento — o que virou verificável foi só o **registro** da decisão; `G3` é taxativo (o motivo tem de nomear a/b/c/d) mas checa o registro, não o juízo; "o que a fecharia" é texto livre e o portão checa se a célula está **preenchida**, não se o conteúdo fecharia a dúvida; e a linha de BARREIRA da `B-06` é verificável por inspeção, mas **quem a escreve é o mesmo agente que ela deveria travar**. | `REDESENHO` — travar julgamento exige um segundo agente, não uma linha de prompt | manter como está e **não confundir com trava**: são artefatos honestos. Quem for endurecer, endureça com um verificador externo |
| — | `README.md:167,356,367,394,456` · `bin/surf.mjs:78-80` · `bin/surf-plan-skill.mjs:176` | O pacote publica **três** skills desde a onda 3; o README diz "both skills" em 5 lugares, o rodapé do `surf --help` nomeia só duas, e o help do plan-bin ainda anuncia `surf-research-skill setup` como conserto — uma **terceira voz** sobre o mesmo assunto, depois de a onda 3 ter unificado a mensagem de portão em `formatGate()`. | `IMPACTO` — prosa estática que envelhece sozinha | trocar a prosa por `SKILLS.length` / `canonicalSkillNames()`, que a onda 5 acabou de exportar em `harness-install.mjs:231` |

### 1.3 — Gasta cota Brave ou trava o run

A conta tem **117 buscas** no mês. Cada item desta tabela custa requisições reais.

| id | onde | o que quebra | por que ficou de fora | correção |
|---|---|---|---|---|
| `BUG-34` (loop-frontier) | `src/lib/ai/frontier.mjs:201` e `:101` · `src/lib/ai/orchestrator.mjs:311` | Uma busca que **falhou** (um 500 transitório) é irrecuperável: `popWave` já tirou o nó de `this.nodes` e a chave continua em `seen`. O analista pedindo a query idêntica de novo é recusado como "duplicate of a query already proposed" — mesmo que ela nunca tenha produzido um resultado. | `REDESENHO` — não é consertável só na fronteira | o agente da onda 2.10 deixou o desenho: um `forget(key)` / `releaseKey()` na `Frontier`, chamado pelo `orchestrator` quando a busca falha. Precisa ser coordenado entre os dois arquivos |
| `BUG-07` (loop-frontier) | `src/lib/ai/frontier.mjs:159` | `quota = ceil(largura/ramos)+1` **sub-preenche** a onda: 10 slots, 21 nós admissíveis, 7 usados. Adicionar um ramo magro **reduz** o throughput. | decisão **D6** do orquestrador: onda dedicada, com a suíte já no portão | redistribuir a sobra depois da primeira passada por ramo |
| `BUG-08` (loop-frontier) | `src/lib/ai/frontier.mjs:160-162` | Com `--sub-agents 1` a reserva de verificação (`max(1, round(w*0.2))`) consome **100%** da onda: um nó de prioridade 0,16 supera cinco de prioridade 1,0. | irmão do `BUG-07`, mesma onda dedicada | reserva só a partir de uma largura mínima |
| `BUG-33` (loop-frontier) | `src/lib/ai/orchestrator.mjs:272` | O teto de 50 ondas é a **única** coisa que para um analista não-convergente. O run é limitado (não há laço infinito), mas gasta 50 requisições Brave e 49 chamadas de LLM e termina com a fronteira ainda cheia. | `REDESENHO` — precisa de um sinal de convergência próprio | os dois contadores criados na onda 2 (`wavesWithoutNewSources`, `wavesWithoutAdmission`) são a base; falta um terceiro sobre **tamanho da fronteira** |
| `BUG-10`/`BUG-11` (loop-frontier) | `src/lib/ai/heuristics.mjs:44-52` e `:69` | Pergunta **vazia** ainda dispara o template: `["official documentation","2026 latest version changelog","limitations problems issues"]` — três requisições Brave reais, sem assunto. E `maxQueries: 0` ainda emite uma query, porque o teto é checado **depois** do push. | `IMPACTO` — o caminho CLI recusa pergunta vazia antes | uma guarda em `heuristicPlan` e mover o teto para antes do push |
| `C3` (lib-install) | `src/lib/api/search.mjs` (fan-out) | Queries **duplicadas** num mesmo fan-out não são dedupadas: `"identical"` foi ao fio 3×, três créditos. | `ASSINATURA` | dedup por query antes do `mapPool` |
| `BUG-39` (brave-limits) | `src/lib/cache.mjs:13` | A chave de cache é hash de `JSON.stringify(args)`, que depende da **ordem de inserção** das propriedades: a mesma busca montada por dois call sites erra o cache e gasta um crédito Brave. | `IMPACTO` | ordenar as chaves antes de serializar |
| — (onda 3.3) | `src/lib/dispatch.mjs:301-303` | `await sleep(e.retryAfterMs)` com o número **cru**, duas vezes, dentro do laço de tentativas e **fora** do guarda de orçamento (que roda uma vez por chave, antes das tentativas). Enquanto esse canal for um `sleep`, **nenhum fato de duração mensal pode trafegar por ele**. | o agente da onda 3.3 contornou pelo lado do produtor (`resolveDelayMs` capa em 5 s e o mês virou `quotaResetAt` no ledger); o consumidor não era arquivo dele | o desenho que ele recomenda: `dispatch` aprender um `kind: 'quota_exhausted'` e **pular** a chave, como `cooldownActive` já faz, em vez de dormir. `dispatch.mjs:304` também sidelina um 429 de cota por só 60 s — o `quotaResetAt` já está no ledger, pronto para ser lido ali |
| — (medido aqui) | `src/lib/ai/openrouter.mjs:74-77`, `:485`, `:503` | `backoff(attempt) = min(1200*(attempt+1)², 8000)` × 3 tentativas × **5 modelos** da cadeia × 2 chamadas de LLM. Com o OpenRouter fora do ar, o run **dorme ~84 s** antes de degradar — contra os **30 s** que `detectHarnessBudgetMs` assume para harness desconhecido. Medido: a seção `orchestrator: degrades when every LLM call fails` do `test/smoke.mjs` responde por **84 s dos 90 s** do arquivo (0,20 s de CPU; o resto é espera). | não triado (custo do portão foi reportado como achado, não como bug) | um teto de backoff derivado do orçamento restante, como a onda 2 fez em `ratelimit.mjs`. **Isto é também o item de custo do portão**: `npm test` leva ~110 s, dos quais 90 s são `smoke.mjs` e 19 s as 5 suítes adversariais juntas |
| `D1` (gate-state) | `src/lib/preflight.mjs:91` vs `src/lib/dispatch.mjs:222` | O portão abençoa a chave **#1** e o `dispatch` reinicia de `p.current`, ignorando o índice: a primeira requisição é gasta na chave **#0**, não julgada. | `ASSINATURA` — `resolveGate` teria de devolver algo que o `dispatch` consome | o agente da onda 3.2 avisou que isto **ganhou mais chances** depois que `keys add` passou a guardar chave não-verificada: agora existe com mais frequência um anel em que parte das chaves não tem veredito. **Priorizar** |

### 1.4 — Contrato de biblioteca

`src/index.mjs` é publicado. Estes itens não afetam a CLI.

| id | onde | o que quebra | por que ficou de fora |
|---|---|---|---|
| `S1` | `src/lib/api/search.mjs` | `search(["x"])` devolve envelope simples e `search(["x","y"])` devolve batch: a **forma do retorno depende do comprimento** do argumento. | `ASSINATURA` |
| `C1` | `src/lib/api/search.mjs:92-95` | `subAgents: 0` significa "sem fan-out" para o chamador e é lido como "não setado" → vira 10. `Number(0)` é finito mas não `> 0`. | `IMPACTO` |
| `C2` | `src/lib/api/search.mjs` | Ids fornecidos pelo chamador não são checados contra colisão: dois batches voltam com o mesmo id e quem indexa por id perde um. | `IMPACTO` |
| `B1` | `src/lib/api/search.mjs:156-163` | `search()` ignora `opts.noBudget` — `buildFlags()` não o repassa, então uma chamada de biblioteca ainda aborta com `LikelyAgentTimeout` no orçamento do harness. | `IMPACTO` |
| `M1` | `src/env.mjs:125-126` vs `:145` | Uma chave passada explicitamente em `opts` **herda o histórico de burn** do `keys.json`, contra a docstring. Só `skipConfigFile` sai disso. | `IMPACTO` |
| `D1` (env) | `src/env.mjs:2` vs `:95-105` | O header promete "each level can contribute; results merged + deduped" — falso para o nível 4: o `keys.json` só é consultado quando os níveis 1-3 não produziram nada. | `IMPACTO` (é a doc que está errada) |
| `D2` | `src/env.mjs` (`ENV_FILE_CACHE`) | O cache do `.env` nunca expira: um `.env` reescrito é invisível pelo resto da vida do processo. | `IMPACTO` |
| `D3` | `src/env.mjs` | `opts.braveKeys` como **string CSV** é tomada como UMA chave; só as env vars fazem split em vírgula. | `IMPACTO` |
| `P5` | `src/env.mjs` | Nome de variável em minúscula no `.env` é ignorado (`brave_api_key=…` → `[]`). | `IMPACTO` |
| `BUG-24` | `src/lib/ai/orchestrator.mjs:122`, `:128`, `:134` | `Number(x) \|\| default`: um knob **zero** vira o default em silêncio. Pedir `subAgents:0 / maxDepth:0 / maxQueries:0` devolve 10/2/10 — o oposto, sem aviso. | `IMPACTO` |
| — | `src/lib/preflight.mjs:106` e `src/lib/keys-cmd.mjs:52` | `provesKeyBad()` existe em **duas cópias**, com comentário cruzado pedindo que não cresça uma terceira. | deliberado na onda 3.2 (`preflight` não exporta e o arquivo não era dele); uma onda futura deveria mover para um módulo de taxonomia |
| — | `bin/surf-research-skill.mjs` (`cmdGate`, :707) | O verbo `gate` não tem `--offline`/`--no-live`: quem consome herda a política de sondagem. E o payload de `gate --json` não carrega `burned`/`cooldowns`/`validated` por chave, só `key_count` — por isso o doctor ainda precisa de um segundo `keys list --json`. | bloqueado pelo `P2` (acima) |
| — | `src/lib/check-surf-skill.mjs:272` | `Math.max(1, usable)` garante a invariante estrutural mas **mascara** uma discordância entre o veredito global e a varredura por chave, em vez de denunciá-la. | `IMPACTO` |

### 1.5 — Instalação e desinstalação

| id | onde | o que quebra | por que ficou de fora |
|---|---|---|---|
| `H3` | `src/lib/harness-install.mjs:81` | `unlinkIfOurs()` **recusa remover uma symlink nossa** depois que ela pendura, porque usa `existsSync()` (que segue o link). Um `npm rm -g` depois de o diretório do pacote sumir deixa os links mortos para sempre. | `REGRESSÃO` — ver [§3](#3-armadilhas-na-régua): corrigir isto acende `lib-install.mjs:644` |
| `H4` | `src/lib/harness-install.mjs:86` | Uma symlink **relativa** nossa não é reconhecida como nossa: `path.resolve(cur)` usa `process.cwd()`, não `dirname(link)`. | `IMPACTO` — a onda 4 já resolveu o caso equivalente em `provenLinkTarget()`; falta usá-la aqui também |
| `H6` | `src/lib/harness-install.mjs:158` | Uma skill legada instalada como **cópia** (o fallback Windows deste próprio módulo) nunca é limpa — só symlinks são removidas. A skill keyless da v7 segue anunciando um binário que não existe mais. | `REDESENHO`, e **de propósito**: uma cópia não tem alvo, logo não tem prova de posse possível. Quem consertar precisa de um **marcador de proveniência dentro da cópia** — um teste por nome reabre exatamente o `H13` que a onda 4 fechou |
| `H12` | `src/lib/harness-install.mjs` (`uninstallSkill`) | `uninstallSkill()` nunca olha `LEGACY_NAMES`. | O buraco **do usuário** já está fechado no nível do script (onda 3.5 fez o `preuninstall.mjs` chamar `cleanupLegacy()`); o `bug()` testa a unidade isolada e descreve um risco já mitigado. Ver [§2](#2-os-que-não-são-bugs) |
| `H11` | `bin/surf-plan-skill.mjs:145` vs `src/lib/harness-install.mjs:15` | O doctor do plan resolve harness dirs por `process.env.HOME`; o instalador por `os.homedir()`. Sob `sudo`/container eles discordam e o doctor acusa instalação quebrada numa máquina sã. | irmão do `H10` (§1.1); sai no mesmo commit |
| `X1` | `src/install/postinstall.mjs` | O `postinstall` sai **não-zero** quando o stdout não é gravável (ENOSPC/EPIPE): o erro de escrita escapa do `catch` do `main()`. Só o `\|\| true` do `package.json` mantém o `npm install` verde — e `cmd.exe` não tem `/bin/true`. | `IMPACTO` — a onda 3.5 blindou o `preuninstall.mjs` com `say()` + `process.stdout.on('error')`; **a mesma blindagem cabe aqui, é cópia direta** |

### 1.6 — Higiene de entrada e cosmético

Último por decisão de ordenação: nenhum destes corrompe estado nem engana o leitor da resposta.

**Parser de flags e superfície da CLI** (suíte `flags-cli`)

| id | onde | o que quebra | por que ficou de fora |
|---|---|---|---|
| `#6` | `src/lib/flags.mjs:59-65` vs `:72-75` | `--sub-agents=` (valor vazio depois do `=`) escapa da guarda de valor-faltando e vira default em silêncio, enquanto `--sub-agents` sozinho é erro duro. | era `REGRESSÃO` de régua (CASO B); a régua **foi consertada** na onda 2 com o helper `attempt()` — hoje o bug é corrigível e só não foi feito |
| `#18` | `src/lib/ai/cli.mjs:122` → `src/lib/ai/orchestrator.mjs:90` | `--budget-ms` é o único numérico que **não** passa por `numericFlag`: vai cru para `Number()`, então `--budget-ms abc` vira `NaN` e é descartado em silêncio em vez de erro de uso. | `IMPACTO` |
| `#19` | `bin/surf-search-unlimit.mjs:58` vs `orchestrator.mjs:156-157` | O `--help` documenta `--budget-ms N`, e `unlimit` fixa `budgetMs = Infinity`: a flag não tem efeito nenhum ali. O próprio help se contradiz 10 linhas abaixo. | `IMPACTO` — a documentação de referência já foi corrigida (A-11); o **help do bin** não |
| `#22` | `bin/surf-research-skill.mjs:410` | `search-parallel` sem query imprime `Usage:` e sai **1** em vez de 2, contra o contrato do próprio `--help` ("1 = a operação rodou e falhou / 2 = você digitou errado"). | era `REGRESSÃO` de régua (CASO F1); a régua foi consertada — o errado era a `ok()` de controle, não o bug |
| `#29` | `bin/surf-search-normal.mjs:86-93` · `bin/surf-search-unlimit.mjs:93-100` | `--help`/`-h`/`--version` só são reconhecidos em `argv[0]`: `surf-search-normal --json --help` não imprime ajuda — e numa máquina sem chave Brave sai **78** pelo portão antes de a ajuda ser considerada. | `IMPACTO` |
| `#16` | `src/lib/ai/cli.mjs:33` | `--brief-file=` (valor vazio) é ignorado em silêncio: o usuário recebe "a question is required" em vez de "--brief-file needs a value". | `IMPACTO` |
| `#17` | `src/lib/ai/cli.mjs:77-97` | O mesmo `--mode fast` é re-lido como `--search-mode` em `surf-search-normal`/`-unlimit` e é erro duro em `surf-research-skill ai`: os três pontos de entrada **driftam**, contra o header do arquivo. | `IMPACTO` |
| `#7`,`#8`,`#9`,`#11`,`#12` | `src/lib/flags.mjs:112-147` | Helpers contradizem as próprias docstrings: `intOr("")`/`intOr(null)` devolvem `min` em vez do fallback; `clamp()` promete um `fallback` que não existe na assinatura e devolve `NaN`; `trunc(0,5)` engole um zero legítimo; `flat()` estoura em objeto circular — e é justamente um achatador de **erro**. | `IMPACTO` — todos latentes: `brave.mjs:275-281` guarda `""` antes de chamar, e `flat()` está exportado mas não usado in-tree |

**Limitador de taxa** (suíte `brave-limits`, todos em `src/lib/ratelimit.mjs`)

| id | linha | o que quebra | por que ficou de fora |
|---|---|---|---|
| `BUG-22` | `:281-283` | `parseMonthlyRemaining` confia em `Number("")`, que é 0: um header com vírgula sobrando reporta "0 requisições no mês" em vez de "desconhecido". | `IMPACTO` — a onda 3.3 **blindou a decisão** de esgotamento com parser estrito (`"1, "` não esgota chave nenhuma, medido); o **contador exibido** ainda grava 0 |
| `BUG-23` | `:283` | Um `remaining` negativo passa direto, sem clamp nem rejeição (`"0, -5"` → `-5`). | `IMPACTO` |
| `BUG-24` | `:266-269` | Com mais de um bucket `w=1` na policy, o **primeiro** vence em vez do **menor**: o limitador adota a mais permissiva de duas permissões contraditórias. | `IMPACTO` |
| `BUG-25` | `:93` | Com pacing desligado, `acquireSlot` reporta `rps: Infinity`, que `JSON.stringify` transforma em `null` ao entrar em qualquer envelope `--json` ou linha de ledger. | `IMPACTO` |
| `BUG-29` | `:188` | `learnFromBody` desiste antes de gravar qualquer coisa quando falta `meta.rate_limit`, descartando o nome do plano e os contadores de cota que o **mesmo corpo** trazia. | `IMPACTO` |
| `BUG-30` | `:113` | O flag `paced` é `now - startedAt > 0`, verdadeiro sempre que a leitura do lock levou 1 ms: reporta pacing que não houve. `brave.mjs:96` disfarça com um limiar de 250 ms. | `IMPACTO` |

**Sanitizador e fronteira**

| id | onde | o que quebra | por que ficou de fora |
|---|---|---|---|
| `BUG-07` (brave) | `src/lib/providers/brave.mjs:233` | Uma data que a regex não parseia é **descartada em silêncio** e a busca roda sem filtro. `--start-date`/`--end-date` são as únicas flags de busca sem guarda (`assertEnum`/`numericFlag`) na CLI. | `REGRESSÃO` **e a asserção está errada** — ver [§2](#2-os-que-não-são-bugs) e [§3](#3-armadilhas-na-régua) |
| `BUG-09` (frontier) | `src/lib/ai/frontier.mjs:71-73` | `seen` e `rejected` crescem sem teto nem eviction: 2000 rejeições = 2000 entradas cada, com `nodes: 0`. O `toJSON` capa o **snapshot** em 50; os arrays em si são ilimitados. | `IMPACTO` — o run é limitado a 50 ondas; a onda 2 manteve `seen` sendo preenchido **de propósito**, para não fazer este `bug()` ficar verde sem ninguém ter consertado nada |
| `BUG-15` (ledger) | `src/lib/ai/ledger.mjs:25` | `canonicalUrl` não é idempotente com barras dobradas: `…/x//` → `…/x/` → `…/x`. Duas passadas dão resultados diferentes. | `IMPACTO` |
| `BUG-23` (ledger) | `src/lib/ai/ledger.mjs:118` | `newSourcesInRound()` é **código morto** — definido e nunca chamado; o orquestrador mede saturação por deltas de `ledger.stats().sources`, e os dois discordam para resultados sem url. | ver [§2](#2-os-que-não-são-bugs) |
| — (onda 4.2) | `src/lib/ai/frontier.mjs:357` vs `src/lib/ai/orchestrator.mjs` | `phantom_closed_branches` é publicado no snapshot da fronteira e **nunca chega ao prompt do analista**: o modelo que alucinou o id não fica sabendo que o pedido foi ignorado e pode repeti-lo toda onda. | achado na própria onda 4; **uma linha no orchestrator** |
| — (onda 4.4) | `src/lib/html.mjs` | Resíduos Unicode conhecidos e declarados: `U+00AD` (soft hyphen — invisível e parte palavra, mas **renderiza** um hífen na quebra, então reprova na régua "apagar só é permitido quando remover não muda nenhum glifo"); `U+FFF9-FFFB`; `&#55296;` (surrogate solitário) materializa string mal-formada e o ledger passa a guardar par quebrado (**uma linha em `safeChar` fecha**); o marcador `[U+202E]` é **forjável** (um snippet pode escrever o texto literal); `ZWNJ`/`ZWJ` seguem sendo divisores invisíveis de token (`scr<ZWJ>ipt`) — só um filtro **contextual** fecharia, e é um contrato bem maior; `CR` não é colapsado, contra a docstring. | `DESIGN` para `ZWNJ`/`ZWJ` (são necessários em persa, índico e emoji); `IMPACTO` para o resto |
| — (onda 2.11 / 4.4) | `src/lib/html.mjs` | Limites conhecidos e documentados no header: `stripHtml('if (a<b && c>d) return;')` → `"if (ad) return;"` (`<b …>` **é** start-tag válida pela especificação; sem parser semântico não dá para separar) e `stripHtml('<a title="a > b">link</a>')` → `'b">link'`. | `DESIGN` — não são regressão; são o preço de não embarcar um parser HTML |

---

## 2. Os que **NÃO** são bugs

O revisor de plano classificou **8** achados como "o teste está errado, ou é decisão deliberada".
O registro da execução não os enumera numa lista única; os que consegui **confirmar contra o fonte**
estão abaixo. Nenhum destes deve ser "consertado".

### 2.1 — Um cache hit é servido sem chave, e isso é deliberado

- **Onde**: `src/lib/dispatch.mjs:172-183` — `bug('BUG-42', 'INFO')` em `test/adversarial/brave-limits.mjs`.
- **O que a suíte observa**: com toda chave queimada, e **sem chave nenhuma**, um hit de cache é
  servido. O invariante da v8 ("no valid Brave key means exit 78 before anything runs") vale no
  **miss** e não vale no **hit**, por até `SURF_CACHE_TTL` (6 h por padrão).
- **Por que é deliberado**: o comentário em `dispatch.mjs:172` diz, literalmente, `Deliberately
  BEFORE the key gate: a cache hit needs no key`. Um hit **não custa crédito e não toca a rede** —
  é a leitura de um arquivo que este mesmo usuário já pagou. Fechar o portão antes do cache
  transformaria uma resposta grátis em um exit 78.
- A instrução dada à sub-tarefa `onda2-invariante-78-lib` foi explícita: *"#8 PRESERVA o cache hit
  sem chave (BL-42 não é bug)"*. O `bug()` foi mantido na suíte, com severidade `INFO`, porque é o
  **único** furo do invariante e um leitor do invariante não o esperaria — é documentação, não
  acusação.

### 2.2 — Os outros

| achado | por que não é bug |
|---|---|
| `LF-35` — stopwords no dedup (`frontier.mjs:37`) | **Decisão de design registrada como discordância explícita do orquestrador.** Uma lista de stopwords aumentaria as colisões que `LF-01`/`LF-02` acabaram de fechar, e os custos são **assimétricos**: uma requisição desperdiçada vs. recusar uma pergunta legítima mentindo o motivo. A sub-tarefa `onda2-fronteira` foi instruída a não implementar, e reescreveu até o comentário para não sujar o `grep` (`grep -in stopword` = vazio). |
| `BL-07` — data descartada em silêncio | **A asserção está errada.** Ela só flipa se `resolveFreshness({startDate:'01/01/2026'})` deixar de ser `undefined` — ou seja, se o adapter passar a **aceitar** uma data ambígua (`01/01` é dia-mês ou mês-dia?) ou um ano de 5 dígitos. Isso contradiz `BL-05` e reintroduz o silenciosamente-errado. O agente da onda 2.6 corrigiu o **comportamento** (`progress.warn` em cada data descartada); a asserção só olha o valor de retorno. |
| `LF-23` — `newSourcesInRound()` é código morto | Não é defeito de comportamento: o orquestrador mede saturação de outro jeito (deltas de `ledger.stats().sources`), e a onda 2 substituiu o contador único por `wavesWithoutNewSources` + `wavesWithoutAdmission`. A função sobrou. Remover é limpeza, não conserto — e removê-la **antes** de decidir qual das duas medidas é a certa apagaria a alternativa. |
| `LI-H12` — `uninstallSkill()` não olha `LEGACY_NAMES` | É um `bug()` que descreve um risco **já mitigado**. A onda 3.5 fez o `preuninstall.mjs` chamar a mesma `cleanupLegacy()` do postinstall; o round-trip real de `npm rm -g` foi medido (16 linhas: 8 `removed <skill>` + 8 `removed legacy`). A asserção testa `uninstallSkill` **isolada** e continua reproduzindo — no nível de unidade, não no do usuário. |
| `plan-skill` mantém `WebSearch`/`WebFetch` em `allowed-tools` | **Deliberado.** A v8 não proíbe a **ferramenta**, proíbe o **uso como plano B**. A onda 2.16 derrubou as três autorizações de fallback (`SKILL.md:145-153`, `:265-266`, `:658`) e deixou um gatilho único — "o harness negou o Bash" — marcado `only if Phase 0 resolved to B`. Remover as ferramentas quebraria o único caso legítimo. |
| `tavily` fora da lista de nomes próprios em `cleanupLegacy()` | **Deliberado.** É nome de skill legada nossa **e também** pacote npm real de terceiro. Incluí-lo reabriria o `H13` (apagar a skill de outra pessoa) exatamente pelo lado que a onda 4 acabou de fechar. |
| `makeNode` não coage `depth` | Fixado como contrato por um `eq()` em `loop-frontier.mjs:212`. A onda 4 endureceu o **portão** (`admit()` exige `depth` finito) sem coagir no construtor — os dois convivem de propósito. |
| Acentos preservados no `queryKey`; barra final antes de query string não normalizada | Lacunas **documentadas** e asseridas com `ok()`: "accents are preserved, so accented/unaccented are NOT deduped" e "a trailing slash before a query string is NOT normalised (documented gap)". |

---

## 3. Armadilhas na régua

Esta execução encontrou **sete** casos em que a própria suíte de testes impedia a correção certa,
em **cinco classes**:

| classe | o que é | casos |
|---|---|---|
| 1 | asserção `ok()`/`eq()` que afirma o **defeito** como contrato | A, C |
| 2 | setup/teardown que **estoura** quando o bug é corrigido, matando a suíte inteira | B, D |
| 3 | **tautologia** que não pode falhar (`x === x`) | E |
| 4 | **contradição** entre duas asserções: nenhum conserto satisfaz as duas | F1 |
| 5 | **fixture confundida** — mede duas causas ao mesmo tempo | F2 |

Cinco foram corrigidas na onda 2 (`onda2-corrige-regua`, commit `c1630fe`) e a sexta na onda 4
(`679b0f8`, a contradição **tripla** do `BUG-06`). O que segue são as que **ainda estão vivas**.

### A regra que saiu daí

> **Um `bug()` é obrigado a sobreviver à própria correção.**

Um `bug()` que mata a suíte quando o defeito é consertado **bloqueia o conserto** — o agente que
tentar arrumar o código vê o portão ficar vermelho e reverte. Corolários, todos aprendidos na marra
nesta execução:

1. **Nunca escreva a condição de um `bug()` fora de um wrapper que sobreviva a um `throw`.** O
   helper `attempt()` de `flags-cli.mjs` existe por isso: `parseFlags` chamado nu, se um dia lançar,
   derruba as 142 asserções seguintes.
2. **Nunca use `ok()` para afirmar um defeito.** `ok()` significa "comportamento correto que não pode
   regredir". Se você quer registrar um defeito, use `bug()` — mesmo que ele hoje reproduza sempre.
3. **A condição de um `bug()` não pode ser constante.** Escreva junto a implementação hipotética que
   a faria falhar; se não conseguir imaginar uma, é tautologia.
4. **Um `bug()` só pode medir uma causa.** Se a fixture contém um segundo motivo de falha, a
   condição não discrimina corrigido de quebrado. Ou remova o confundidor, ou converta a condição em
   **traçador** (discriminar pelo texto do stderr, e não pelo exit code).
5. **Quando duas asserções não podem ser ambas verdadeiras, uma delas está errada** — e não é
   necessariamente a mais nova. Nos dois casos desta execução (`F1` e `F2`) quem estava errado era o
   **controle**, não o `bug()`.

### As que ainda estão vivas

Quem for consertar os bugs abaixo precisa saber disto **antes**, não depois.

| asserção | acende quando | por quê | o que fazer |
|---|---|---|---|
| `test/adversarial/gate-state.mjs:281` — `ok('and the poisoned verdict survives a round-trip through keys.json', …)` | **`P1` for corrigido em `normalizeProvider`** | A asserção exige `back.brave.validated.length === 1` depois de gravar um veredito com `at` dez anos no futuro. Se `normalizeProvider` passar a podar entradas com data futura, o `length` vira 0 e a linha fica **vermelha**. | converter em `bug()` no mesmo commit que corrige o `P1` — ela hoje **afirma o defeito como contrato** (classe 1) |
| `test/adversarial/brave-limits.mjs:306` e `:311` — `bug('BUG-06', …)` e `bug('BUG-07', …)` | **a validação de data for corrigida LANÇANDO no adapter** | As condições avaliam `resolveFreshness({…})` como **argumento** de `bug()`, no nível do módulo. Se `resolveFreshness` passar a lançar, o `throw` escapa e **mata a suíte inteira** — 137 asserções e o ledger de 44 defeitos (classe 2). | corrigir `BUG-07` com `progress.warn` + valor de retorno explícito, como a onda 2.6 fez com `BUG-05`/`BUG-06`. Se precisar lançar, embrulhe as condições num `attempt()` **primeiro**, num commit separado |
| `test/adversarial/lib-install.mjs:644` — `eq('seven of our eight links are removed', …, 7)` | **`H3` for corrigido**, ou o `fakePkg()` ganhar `skills/surf-search-agent-skill/` | Ela passa **por coincidência** desde a onda 3: o pacote tem 3 skills × 4 dirs = 12 links, `fakePkg()` não cria o diretório da skill nova, os 4 links dela ficam pendurados e o `H3` se recusa a removê-los — 12 − 4 − 1 (cópia do usuário) = 7. Consertado o `H3`, o número vira 11 e a linha fica vermelha. O texto "eight links" **já está errado** hoje. | ajustar o número **e** o texto no mesmo commit do `H3`; ou adicionar o dir ao `fakePkg()` primeiro, o que também a quebra |
| `test/adversarial/lib-install.mjs:610` — `ok('the broken link is still there afterwards', lstatSync(l5).isSymbolicLink())` | **um futuro conserto de `H1` reparar por CÓPIA** em vez de symlink | Dormente: `H1` foi corrigido por symlink na onda 2, então a asserção passa. Ela **constrange** qualquer reimplementação: reparar copiando faz `isSymbolicLink()` virar false. O texto também envelheceu — hoje o link não é mais "broken", é reparado. | se for reparar por cópia, converter esta linha no mesmo commit |
| 6 asserções não convertidas no CASO C | — | A onda 2 varreu por mais instâncias da classe 1 e converteu **1** (a única inequívoca), deixando **6 relatadas e não convertidas**. O registro da execução não as nomeia. | ao mexer numa suíte, desconfie de qualquer `ok()` cuja descrição narre um comportamento **indesejável** |

---

## 4. Decisões de produto tomadas nesta execução

Um mantenedor futuro precisa conhecer estas para não desfazê-las sem querer. Todas custaram
argumento e várias custaram uma sub-tarefa inteira.

### 4.1 — `keys list` **não** exige chave, e nunca vai exigir

`keys` está em `NO_KEYS_NEEDED` (`bin/surf-research-skill.mjs`), então `keysList` só faz
`loadState()` e **sempre sai 0**. A auditoria (A-04/A-05) mostrou que o portão da FASE 0 da skill
mandava rodar `keys list` e parar "se sair 78" — um **ramo morto**.

A correção **não** foi tirar `keys` do `NO_KEYS_NEEDED`: *diagnosticar uma chave faltando exige que o
diagnóstico funcione sem chave*. Em vez disso a onda 2 criou o verbo **`surf-research-skill gate`**
(também em `NO_KEYS_NEEDED`), que chama `resolveGate` e sai **78** quando o veredito não é READY, e
apontou a FASE 0 para ele. O `SKILL.md` hoje proíbe explicitamente `keys list` como portão.

**Não "conserte" o `keys list` fazendo-o sair 78.** Isso quebra exatamente o caso de uso para o qual
ele existe.

### 4.2 — O `surf doctor` sonda a rede **por padrão**

Decisão da onda 4.3, com escape explícito (`surf doctor --offline`, `SURF_DOCTOR_OFFLINE=1`).
O argumento:

> Ficar offline seria **pior que inútil** para o deep-orchestrator: o portão offline não consegue
> devolver `UNREACHABLE`, então rede caída + chave nunca julgada dava **exit 0** e a execução inteira
> morria na primeira busca com 78. Um doctor usado como portão tem de **prever o comando seguinte**,
> não bajulá-lo.

Os fatos que sustentam: a sonda custa **0 crédito** (uma request sem `q` é rejeitada antes de ser
cobrada), é cacheada 7 dias (em máquina assentada o doctor põe **zero** na rede) e é exatamente a
mesma sonda que o `surf-search-normal` seguinte faria. No modo `--offline` o doctor **se recusa a
certificar** o que não checou: `⚠ undecided`, exit 0, sem mentir para nenhum dos dois lados.

Contra-prova medida, com rede caída e chave nunca julgada — antes: `unvalidated`, "1 configured, 1
usable", **exit 0**. Depois: `unreachable`/`BraveKeyUnverified`, "1 configured, 0 usable", **exit 78**.

### 4.3 — A lista de stopwords no dedup foi **rejeitada**

Ver [§2.2](#22--os-outros). Registrada como *discordância explícita* do orquestrador contra o achado
`LF-35`, e a sub-tarefa foi instruída a não implementar. O motivo é a **assimetria de custos**: uma
requisição desperdiçada custa 1 de 117; recusar uma pergunta legítima **mentindo o motivo**
("duplicate") custa a resposta.

A mesma assimetria produziu o trade-off assumido da nova `queryKey`: ela ficou **estritamente mais
frouxa** (uma reformulação com ordem trocada passa a ser admitida e custa 1 requisição a mais). É o
lado barato.

### 4.4 — `auth` é o único veredito **irreversível**, e isso impõe a ordem de classificação de erro

`markBurned` não tem expiração — só `keys clear-burned` manual. Logo, na `mapError` de
`src/lib/providers/brave.mjs`, **tudo que se recupera sozinho tem de ser testado antes**, e o teste
de `auth` ainda é coado pelo status. A ordem, que **não deve ser reordenada**:

1. tabela de códigos documentados, por **igualdade exata**
2. `status === 429` → `rate_limit_429`, **aconteça o que acontecer no corpo**
3. padrão transitório (`QUOTA|RATE_LIMIT|EXCEEDED|THROTTL|TOO_MANY`)
4. plano
5. config
6. **`auth` por último, e só em 401/403/422**
7. fallback por status

Era exatamente o inverso: `/TOKEN|SUBSCRIPTION/` sem âncora, em primeiro lugar e cego ao status — um
429 de cota mensal **queimava a chave**, e até um HTTP 200 com esse código queimava. Dois
sub-produtos da mesma regra: **402** ("sem crédito") passou de `auth` para `rate_limit_429`, porque
crédito volta no mês seguinte e queimar é irreversível; e `mapError` virou
`try{classify()}catch → kind seguro` — **nunca mais lança**.

A mesma disciplina governa o **portão de chave** (onda 2.2): a regra virou **whitelist**, não
blacklist. Só `kind === 'auth'` é prova sobre a **chave**; `network`, `server_5xx` e qualquer status
não atribuído (portal cativo, proxy 407, mudança de API da Brave) são fatos sobre o **caminho** até a
Brave e **não são gravados** — a chave fica `UNVALIDATED` e a próxima execução re-sonda, de graça.
*"Custo de errar assim: um round-trip. Custo de errar do outro jeito: uma semana de exit 78 numa
chave boa."* O predicado literal, copiado em duas cópias com comentário cruzado:

```js
r.valid === false && r.kind === 'auth'
```

**Exceção deliberada em `keys add`** (`src/lib/keys-cmd.mjs`): `validateKey()` tem dois `kind` que o
gate nunca vê — `malformed` (vazia ou < 8 chars) e `unknown_provider` — decididos **antes de qualquer
requisição sair da máquina**. Como nada foi percorrido, não há caminho para culpar: continuam
recusando. Sem essa exceção, um whitelist puro passaria a **guardar lixo de 3 caracteres**.

### 4.5 — Quando o relógio mente, a resposta é pacing **a mais**, nunca a menos

Regra da onda 2.7, aplicada em quatro pontos de `ratelimit.mjs`: um carimbo até **uma janela** à
frente é **grampeado** para `now` (irmão com relógio adiantado; contá-lo mantém o pacing
conservador); além disso é **descartado**. `resolveRps` desconfia de `at` mais de 24 h no futuro,
`cacheGet` rejeita `ts` futuro além do TTL, e `lockIsAbandoned` usa comparação **unilateral** —
idade negativa **não** é prova de abandono, então relógio quebrado nunca quebra lock.

### 4.6 — Um sinal transitório compra **pausa**, nunca decisão irreversível

O oposto do `markBurned`. A cota mensal virou `quotaResetAt` no ledger (**instante absoluto**), com
três mecanismos de reversibilidade: hold vencido devolve o paralelismo sem ninguém rodar nada; a
primeira resposta que **reporta** cota derruba a marca na hora (e um 200 **sem** o header não
derruba — **ausência não é zero**); e o hold é travado em 31 dias na escrita e ignorado na leitura se
mais distante que uma janela mensal.

### 4.7 — A fronteira entre a skill rasa e a profunda é **estrutural**, não disciplinar

`skills/surf-search-agent-skill/` (onda 3.1) não recebe `Agent`, `Task`, `WebSearch`, `WebFetch`,
`Write` nem `Bash(git:*)` no `allowed-tools`: ela **escala para a irmã profunda falando, nunca
invocando**. O eixo de fronteira é observável — *quantas perguntas independentes a resposta exige* —
e **não** é "rápido/importante/difícil" (varredura por `rápido|quick|fast|importan|difícil|hard|easy|trivial`
nas duas `description` = zero). Ambas citam a irmã **pelo nome** num bloco "DO NOT use".

Anti-canibalização: `pesquise`, `investigue`, `busca na web`, `search the web` e `investigate` foram
**removidos** da skill profunda e agora só a rasa os tem. `research` sobrevive 2× na profunda, ambas
qualificadas. **Adicionar um gatilho genérico a qualquer uma das duas desfaz isto.**

### 4.8 — Evidência manipulada é **sinalizada**, não apagada

Regra da onda 4.4, e o critério **não** é "invisível":

> Apagar só é permitido quando remover o caractere não muda nenhum glifo nem nenhuma palavra em
> nenhuma escrita.

Por isso: controles C1 e TAG CHARACTERS (`U+E0000-E007F`, o canal de **ASCII smuggling**) são
**apagados**; os 9 controles BIDI são **sinalizados** com um marcador imprimível `[U+202E]`, porque
*"a presença de um RLO num snippet da Brave não é preferência de formatação, é a própria constatação:
apagar em silêncio devolve um trecho que parece limpo e nunca diz que houve manipulação"*; e
`ZWNJ`/`ZWJ` são **mantidos** (seguram sequência de emoji e são a diferença entre duas palavras
persas). A bandeira da Escócia (`U+1F3F4` + tag sequence) tem carve-out explícito.

O sanitizador tem **três passos**, nesta ordem, e a ordem é o conserto:
`neutralizeTags(decodeEntities(stripTags(s)))`. Decodificar primeiro **deletaria** todo snippet que
*fala* de HTML; escapar tudo quebraria `5 < 10`. As duas só são compatíveis sob a regra do tokenizer
do HTML5: `<` seguido de letra, `/`, `!` ou `?` abre tag; qualquer outro `<` é texto.

### 4.9 — O portão de teste é uma **sequência acumuladora**, não `&&`

`npm test` roda as 7 suítes **todas**, coleta as que falharam e sai 1 nomeando-as. Um merge quebrado
entrega o diagnóstico inteiro numa rodada, não 1/7. `test:syntax` continua pré-requisito **rígido**
(um `.mjs` que não parseia mata toda suíte que o importa no module-load e o output vira ruído).
O glob tem guarda `n == 0` para o portão **não encolher em silêncio**. Só construção POSIX, validada
em `/bin/sh`, `bash --posix` e zsh-emulando-sh.

Consequência para quem mexe no código: **linhas `bug()` não derrubam o portão** (consertar um bug
nunca fica vermelho). O que morde são as 1083 `ok()`/`eq()`. E as suítes **stubam `fetch` e `HOME`
antes do primeiro import**: qualquer mudança que introduza rede ou leitura de `HOME` em tempo de
module-load quebra a suíte **inteira**, não uma asserção.

---

## 5. O que não foi verificado

Honestidade sobre os limites desta auditoria.

| não verificado | por quê | consequência |
|---|---|---|
| **Zero chamadas à API Brave real** | A conta tinha ~117 buscas no mês; foi proibido a todas as 33 sub-tarefas fazer chamada real. Todo teste é offline, com `globalThis.fetch` stubado e `HOME` num diretório temporário. Uma sub-tarefa rodou dentro de `unshare -rn` (namespace de rede sem rota) com preload instrumentando `net.Socket.prototype.connect` e `dns.lookup/resolve` — **abaixo** do `globalThis.fetch`, onde um stub esquecido apareceria: zero pacotes para `api.search.brave.com` e `openrouter.ai`. | **Nenhuma** afirmação sobre o comportamento real da Brave foi confirmada: que o `/llm/context` é plan-gated, que requisições falhas não contam cota, o A/B de 108 requisições. Só os comentários do **próprio repo** as sustentam — é **circular** |
| **Node 18 não testado** | `engines` declara `>=18`; tudo rodou no Node desta máquina | sintaxe e APIs usadas nas correções não foram exercitadas no piso declarado |
| **O roteamento de skill por um harness real** | O teste de canibalização (10 perguntas, 0 mal roteadas) é **proxy de casamento de frases**, não o roteador | não se sabe se Claude Code/Copilot/OpenCode escolhem a skill prevista |
| **O modo degradado fim a fim** | Exigiria rede e cota. A chave OpenRouter deste ambiente falha com `auth` (`deepseek#0:auth`), então o `surf-ai` roda no caminho determinístico sem síntese | a declaração obrigatória de modo degradado na skill rasa foi verificada por **leitura**, não por execução |
| **O comportamento fim a fim da CLI** | idem | os testes exercitam módulos e bins com stub, não uma execução real com resposta da Brave |
| **Timeouts de harnesses de terceiros** | Claude Code 120/600 s, Copilot 30 s, OpenCode 600 s são afirmações sobre software alheio; **nada em `src/` as sustenta** | os números do README podem estar errados e não há como saber daqui |
| **Custos e tempos típicos** | "45-110 s, ~$0.01-0.03" são **medições**, não constantes | envelhecem sozinhos |
| **A exaustividade das 17 `stop_reason`** | Veio de `grep` completo das atribuições, não de cobertura de teste | uma frase nova escapa da tabela |
| **Um flake de ambiente observado, não explicado** | Numa rodada o `unshare -r` mapeou uid diferente e `lib-install`/`brave-limits` mudaram de veredito (`G1-G3` "FIXED", `BUG-41` sumindo). Re-execuções batem o baseline byte a byte | se aparecer em CI, o suspeito é o **mapeamento de uid**, não o código |

---

## 6. O que o registro da execução listava como aberto e já está fechado

Registrado para que ninguém reabra o que já foi feito.

| item | fechado por | prova |
|---|---|---|
| `FC-#30` / `A-01` — deriva de versão: 8 `const VERSION` dizendo `8.0.0` contra `package.json` `8.0.1`, incluindo o `X-Client-Name` de toda request Brave | onda 5, `0f7126e` (`src/lib/version.mjs`, `scripts/sync-version.mjs`) | `flags-cli`: `✓ BUG#30 APPEARS FIXED`; `lib-install`: `✓ FIXED V1`, `✓ FIXED V2`. Todo `8.0.0` restante no repo é referência histórica |
| Pedido da onda 4.3: **exportar `SKILLS`** em `harness-install.mjs` para matar o nível 2 do `canonicalSkillNames()` | onda 5, `0f7126e` | `export const SKILLS` em `harness-install.mjs:231` |
| `bin/surf.mjs:87` — `skillsToCheck` hardcoded com 2 skills: o `surf doctor` nunca veria a skill nova | onda 4.3 | o comentário em `bin/surf.mjs:102-104` narra a substituição |
| `references/surf-ai-cli.md` — 8 campos fantasma (`diagnostics.queriesFailed` entre eles) | onda 4.5, `4d69511` | o arquivo ganhou a seção "Campos que NÃO existem" e 45+ campos reais antes não documentados |
| A frase obsoleta de coordenação em `skills/surf-search-agent-skill/SKILL.md` sobre o campo fantasma | já reescrita | o texto atual diz "`references/surf-ai-cli.md` **now** lists this name … under **Campos que NÃO existem**" |
| `--concurrency` obsoleto em **exemplo executável** | onda 2.16 | as duas ocorrências restantes (`references/surf-ai-cli.md:76`, `README.md:534`) documentam o alias como **depreciado**, que é o certo |
| `LF-06`/`LF-06b` — `closeBranch()` de ramo inexistente blacklistando para sempre; **contradição tripla** entre `loop-frontier.mjs:221`, `:831` e `:193-200` | onda 4.2, `679b0f8` | `○ BUG-06`, `○ BUG-06b` não reproduzem; `phantom_closed_branches` registra o pedido |
| `LF-05` — `admit()` aceitando nó sem `priority` (comparador devolvendo `NaN`) | onda 3.6 | `○ BUG-05` |
| `BL-36`/`BL-37` — controles C0 no prompt; `decodeEntities` devolvendo `number` | onda 3.6 | `✓ BUG-36`, `✓ BUG-37` |
| `BL-27`/`BL-28` — um 200 sem header apagando a cota mensal; paralelismo dobrado por chave duplicada | onda 3.3 | `✓ BUG-27`, `✓ BUG-28` |
| `keys add` recusando uma chave **boa** com a rede caída | onda 3.2 | `gate-state` 223/0, 24 fixed |
| `H13` — `cleanupLegacy()` apagando a skill de terceiro com nome legado | onda 4.1 | `✓ FIXED H13` |
| `README` — `BraveKeyUnverified` sem documentação; `:871` mandando "replace" antes de `keys reset`; 14 afirmações falsas | onda 3.7 | commit `d49577e` |
| Onda 7 (2026-08-30): barreira entre rajadas reescrita como imposição por fluxo com artefato em disco (`SKILL.md` R4/R5) | onda 7, commit `c144dbd` | a trava por parâmetro inexistente (`run_in_background`) foi substituída por mecanismo verificável — linha `<!-- BARREIRA rajada N: em-voo=X recebidos=0 -->` no topo do `DOUBTS.md`, relida na fase 4 |

---

## Apêndice — números desta base

```
npm test                     exit 0, GATE GREEN, ~110 s
  test:syntax                ~1 s
  test/smoke.mjs             119 asserções   90 s   (84 s numa seção só: openrouter backoff)
  test/brave.mjs             144 asserções    <1 s
  test/adversarial/*.mjs     5 suítes        19 s
    brave-limits              137 ok/eq · 9 defeitos vivos · 35 fechados
    flags-cli                 142 ok/eq · 13 defeitos vivos · 19 fechados
    gate-state                223 ok/eq · 5 defeitos vivos · 24 fechados
    lib-install               203 ok/eq · 21 defeitos vivos · 23 fechados
    loop-frontier             115 ok/eq · 15 defeitos vivos · 26 fechados
                                          ── 63 defeitos vivos nas suítes
```

Estado real do usuário, verificado antes e depois de rodar tudo: `md5` de
`~/.config/surf/keys.json` e de `~/.cache/surf/ratelimit.json` **inalterados**.
