# Auditoria dos prompts do surf-agent-skill v8.0.1

Auditoria adversarial dos **prompts** (`SKILL.md`, `skills/surf-plan-agent-skill/SKILL.md`,
`references/*.md`) contra o **código real** (`src/`, `bin/`, `package.json`).
Nenhum arquivo auditado foi editado. Toda afirmação abaixo cita `arquivo:linha`
dos dois lados.

- Onda: 1 — auditoria de prompts (deep-orchestrator)
- Roteador lido primeiro, integralmente: `.claude/skills/project-router/SKILL.md`
  (declara v8.0.0, 5 bins, 2 skills, invariante Brave-only / exit 78 — confere
  com o código, exceto a versão, ver A-01)
- Restrição respeitada: **zero chamadas de rede**. 100% leitura local.

---

## Sumário executivo

| Frente | Veredito |
|---|---|
| **A.** Os prompts dizem a verdade sobre a v8? | **NÃO** — 14 afirmações falsas ou obsoletas, 3 delas de severidade ALTA. A pior: o *portão da chave* da fase 0 do orquestrador testa um código de saída que o código nunca produz. |
| **B.** A research tira TODAS as dúvidas? | **PARCIAL, e o modo de falha é silencioso.** Ela tira *muitas* dúvidas e é honesta sobre as que admite. Mas existem **5 caminhos** pelos quais ela entrega com dúvida aberta *sem declará-la*, e a regra de convergência C3 é **inexecutável como escrita**. |
| **C.** Falta uma skill de busca normal? | **SIM, e a falta é cara.** O piso de custo da research é **6 sub-agentes + um commit git** para *qualquer* pergunta, inclusive "qual a versão atual do pgvector?". Os gatilhos genéricos (`pesquise`, `busca na web`, `search the web`, `research`) hoje caem todos nesse piso. Especificação completa na seção C. |

---

# A. Afirmações FALSAS ou obsoletas nos prompts

## Tabela

| # | arquivo:linha (a afirmação) | O que afirma | O que o código faz (arquivo:linha) | Sev. |
|---|---|---|---|---|
| A-01 | `SKILL.md:26` · `skills/surf-plan-agent-skill/SKILL.md:25` | `metadata.version: "8.0.0"` | `package.json:3` declara `"version": "8.0.1"`. Todos os 8 `const VERSION` do código também dizem `'8.0.0'` (`bin/surf-research-skill.mjs:27`, `bin/surf-search-normal.mjs:23`, `bin/surf-search-unlimit.mjs:19`, `bin/surf.mjs:29`, `bin/surf-plan-skill.mjs:12`, `src/lib/dispatch.mjs:24`, `src/lib/ai/orchestrator.mjs:50`, `src/validators/index.mjs:25`) e `src/install/postinstall.mjs:71` imprime `8.0.0`. `--version` mente sobre o pacote instalado. | BAIXA |
| A-02 | `references/burst-templates.md:1` | `# Burst templates — surf-research-agent-skill v7` | O arquivo documenta o contrato T1–T8 da **v8** (fala de exit 78, Brave-only, `--sub-agents`). Cabeçalho é resíduo da v7. | BAIXA |
| A-03 | `references/failure-modes.md:1` | `# Modos de falha — surf-research-agent-skill v7` | Idem: o corpo é todo v8 (`failure-modes.md:28` "A v8 é Brave-only"). | BAIXA |
| A-04 | **`SKILL.md:253-256`** | "PORTÃO DA CHAVE — antes de qualquer rajada, rode `surf-research-skill keys list`. **Se ele sair com código 78**, ou se a seção `brave` não tiver nenhuma chave utilizável, PARE AQUI." | **`keys` está na lista `NO_KEYS_NEEDED`** (`bin/surf-research-skill.mjs:658-662`), logo o portão `assertProviderReady` em `:663` **é pulado**. `keysList` (`src/lib/keys-cmd.mjs:138-179`) só faz `loadState()` e imprime markdown; retorna `{text}` e o bin sai 0 (`bin/surf-research-skill.mjs:586-589`). **`keys list` NUNCA sai 78.** O ramo inteiro é código morto. | **ALTA** |
| A-05 | `SKILL.md:254-256` (2ª metade da mesma frase) | "…ou se a seção `brave` não tiver nenhuma chave utilizável" — tratado como equivalente ao 78 | `keysList` não valida nada. Uma chave **nunca validada** aparece como `- [0] BSA-A…bcd` sem flag nenhuma (`src/lib/keys-cmd.mjs:156-164`); só chaves com veredito em cache ganham `validated`/`INVALID`. A validação real (que é grátis e é o que decide) só acontece em `resolveGate` (`src/lib/preflight.mjs:119-158`), chamado por `preflightOrExit` (`:235`), que `keys list` não invoca. O portão da fase 0 dá **falso positivo** para chave morta e **falso negativo** para chave boa ainda não sondada. | **ALTA** |
| A-06 | **`skills/surf-plan-agent-skill/SKILL.md:118-121`** | "Se uma chamada da Layer A falhar mid-flow (**key burned**, timeout, permission denied), **mude para a Layer B** [WebSearch/WebFetch] para as chamadas restantes" | `GATE.BURNED` (`src/lib/preflight.mjs:71-77`) → `GateError` → **exit 78** (`:216-221`, `:28`). A própria plan-skill diz o oposto 20 linhas acima: `skills/surf-plan-agent-skill/SKILL.md:98-100` "Exit 78 … **stop** … **do not fall through to another layer**". E o `SKILL.md` raiz proíbe categoricamente (`SKILL.md:45-48`, `:571-574`). Contradição interna que autoriza exatamente o comportamento que a v8 existe para eliminar. | **ALTA** |
| A-07 | `skills/surf-plan-agent-skill/SKILL.md:25` (`metadata.requires`) | Lista `node>=18`, os bins, a chave OpenRouter, `WebSearch/WebFetch como Layer B` e o diretório de planos | **Não menciona a chave Brave.** É o único pré-requisito que faz TODO comando de pesquisa sair 78 (`src/lib/preflight.mjs:1-6`, `:235-253`). Comparar com `SKILL.md:27` (raiz), que exige "uma **VALID BRAVE SEARCH key** … sem ela todo comando sai 78". A plan-skill anuncia como opcional o que é obrigatório. | **ALTA** |
| A-08 | `skills/surf-plan-agent-skill/SKILL.md:7` e `:22` | `description`: "falls back to WebSearch/WebFetch when Bash is blocked"; `allowed-tools` inclui `WebSearch, WebFetch` | Compatível *só* com o caso "Bash bloqueado" (Layer B legítima), mas combinado com A-06 vira o plano B genérico que a v8 aboliu. O `SKILL.md` raiz declara na `description` (`SKILL.md:8-9`) "no fallback provider and no free tier underneath". Duas skills do mesmo pacote contam histórias diferentes sobre a invariante central. | MÉDIA |
| A-09 | **`references/surf-ai-cli.md:60`** | `--max-queries N` · padrão **6 (normal) / 10 (unlimit)** · "máx **24**" | Padrões reais: **10 (normal) / 14 (unlimit)** — `src/lib/ai/orchestrator.mjs:65-68`. Máximo real: **40** — `src/lib/ai/cli.mjs:117` (`max: 40`) e `src/lib/ai/orchestrator.mjs:128`. Os três números estão errados. | MÉDIA |
| A-10 | **`references/burst-templates.md:276`** + `references/failure-modes.md:39` | Escada de falha do T3: "Qualquer outra falha → tente mais uma vez com **`--max-queries 4`**" | `src/lib/ai/orchestrator.mjs:127-130`: `maxQueries = Math.max(clamp(opts.maxQueries,1,40), subAgents)`. Com `--sub-agents=10` (o default, e o que o T3 manda quando a rajada tem 1 dúvida — `SKILL.md:352-353`), `--max-queries 4` vira **10**. **A retentativa prescrita é inerte** exatamente no caso em que a rajada é pequena. Só funciona quando `SUB_AGENTS_EACH ≤ 4`. | MÉDIA |
| A-11 | **`references/surf-ai-cli.md:68`** | `--budget-ms N` · "autodetectado" · "**Passe 600000 para unlimit**" | `src/lib/ai/orchestrator.mjs:156-158`: `const budgetMs = mode === 'unlimit' ? Infinity : resolveNormalBudget(...)`. **Em `unlimit` o `--budget-ms` é ignorado incondicionalmente.** O help do próprio bin repete o erro (`bin/surf-search-unlimit.mjs:57`) e se contradiz 10 linhas abaixo (`:68` "⚠ No time budget is enforced"). | MÉDIA |
| A-12 | **`SKILL.md:353-354`** · `SKILL.md:528-529` · `references/burst-templates.md:236-238` | "sem isso, 10 sub-agentes com o default de 10 são **100 requisições simultâneas ao Brave**" | Impossível pelo código: todo request passa por `acquireSlot()` antes do fetch (`src/lib/providers/brave.mjs:94-97`), um token bucket **cross-process** em `~/.cache/surf/ratelimit.json` (`src/lib/ratelimit.mjs:26-30`, `:92`). Seriam 100 requisições **enfileiradas**, não simultâneas. O próprio `SKILL.md:536-538` diz o certo ("não falha, mas demora") e `references/brave-api.md:124-133` explica que o ledger é cross-process *justamente porque* os sub-agentes são processos separados. A prescrição (dividir o leque) continua boa — por latência —, mas a **justificativa é falsa** e contradiz duas outras páginas do próprio pacote. | MÉDIA |
| A-13 | **`references/surf-ai-cli.md:140`** | Tabela "Variáveis de ambiente" (do CLI surf) lista `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` — "Teto de sub-agentes simultâneos (padrão 20)" | `grep -rn 'CLAUDE_CODE_MAX_CONCURRENT' src/ bin/` → **zero ocorrências**. É variável do harness, não do surf. O CLI lê apenas `OPENROUTER_API_KEY`, `SURF_AI_MODEL` (`src/lib/ai/openrouter.mjs:70`), `SURF_QUIET` (`src/lib/progress.mjs:35`), `SURF_AI_BUDGET_MS` (`src/lib/ai/orchestrator.mjs:90`), `SURF_CACHE_TTL` (`src/lib/cache.mjs:9`), `SURF_BRAVE_DEFAULT_RPS` (`src/lib/ratelimit.mjs:34`), `SURF_RATE_LIMIT_COOLDOWN_MS` (`src/lib/dispatch.mjs:27`) — nenhum deles documentado nessa tabela. | MÉDIA |
| A-14 | `references/surf-ai-cli.md:112-113` | "**Quando o surf-ai não está disponível (sem chave OpenRouter, por exemplo)**, o sub-agente ainda tem busca crua" | Sem chave OpenRouter o surf-ai **continua disponível e sai 0**: cai para `heuristicPlan` (`src/lib/ai/orchestrator.mjs:246-251`) e `heuristicSynthesis` (`:466-469`), que emite um cabeçalho `⚠ Degraded mode — no LLM synthesis` (`src/lib/ai/heuristics.mjs:125-128`) e entrega as evidências. "Indisponível" é a palavra errada; o correto é "degradado". Consequência prática: o sub-agente é induzido a trocar de ferramenta quando deveria apenas rebaixar a confiança (o sinal 2 de `references/surf-ai-cli.md:97-98` já cobre isso). | BAIXA |

## Contradições internas (prompt × prompt, sem lado de código)

| # | arquivo:linha | Problema |
|---|---|---|
| A-15 | `SKILL.md:40-44` vs `SKILL.md:22` | O `<enforcement>` afirma "Você **TEM** WebSearch, WebFetch e os binários surf-search-* no seu pool — e não os usa", e justifica: "qualquer restrição de ferramenta declarada no frontmatter se propaga para os sub-agentes da rajada e desarmaria a busca deles". Mas o `allowed-tools` da linha 22 **já é uma lista restritiva** que omite `WebSearch`, `WebFetch` e `Bash(surf-search-*)`. Ou a propagação existe — e então a própria lista da linha 22 já desarmou os sub-agentes —, ou não existe — e então a justificativa da linha 42 é falsa. As duas afirmações não podem ser verdadeiras juntas. |
| A-16 | `SKILL.md:41-48` vs `references/surf-ai-cli.md:111-120` | O `<enforcement>` diz que os sub-agentes buscam "por UM caminho só: **os binários surf-search-***". A referência abre um terceiro caminho, `surf-research-skill search` / `search-parallel` ("Toolbox manual — busca crua"), que **não** é um binário `surf-search-*` (é subcomando de `bin/surf-research-skill.mjs:698-699`). A escada de falha do T3 (`references/burst-templates.md:270-281`) não menciona esse caminho. Ou ele é permitido e a R1 precisa nomeá-lo, ou não é e a referência precisa removê-lo. |
| A-17 | `references/burst-templates.md:518-525` (T8) vs `SKILL.md:165-166` (R9) e `SKILL.md:358-360` | O relatório final decompõe `{{F}}` ("abertas na entrega") em **exatamente dois grupos**: "as admitidas na triagem (modo único) e as que nunca foram disparadas por estouro do teto da rajada". A R9 e a fase 3 criam um **terceiro** estado terminal, `BLOQUEADA`, que "aparece como questão em aberto". **BLOQUEADA não tem casa em nenhum dos dois grupos de F** — e nenhum outro contador do T8 a acomoda. Ver B-03. |

## Afirmações que NÃO consegui derrubar (checadas e corretas)

Registro por honestidade — foram alvos deliberados, não passaram batido:

- Exit codes `0 / 1 / 2 / 78 / 143` (`references/surf-ai-cli.md:148-155`) — conferem com `src/lib/ai/cli.mjs:141-143` (1 só quando `sources === 0`), `:155-166` (2 para usage), `src/lib/preflight.mjs:28` (78) e `bin/surf-search-normal.mjs:73-82` (143).
- `--sub-agents` default 10 / máx 20 (`references/surf-ai-cli.md:61`) — `src/lib/ai/orchestrator.mjs:72-73`, `:121-124`.
- `--max-rounds` default 6 / teto 50, `--max-depth` 2 (normal) / 3 (unlimit) / máx 6, `--max` 5/8 e 1-20 (`references/surf-ai-cli.md:63-65`) — `src/lib/ai/orchestrator.mjs:65-68`, `:131-141`.
- `--concurrency` como alias obsoleto (`:62`) — `src/lib/ai/cli.mjs:104-109`.
- Cache de 6 h (`references/COSTS.md:71`) — `src/lib/cache.mjs:9` (`21600` s).
- 2 chamadas OpenRouter em normal, `2 + waves` em unlimit (`references/COSTS.md:60`) — o `break` do modo normal (`src/lib/ai/orchestrator.mjs:333`) acontece **antes** do bloco ANALYZE (`:346`), então normal = plan + synthesis.
- Cadeia de modelos DeepSeek do project-router — `src/lib/ai/openrouter.mjs:42-47`.
- `references/brave-api.md` inteiro: `count` 1-20 / `offset` 0-9, `text_decorations:0`, `extra_snippets`, `more_results_available` lido como `=== true`, classificação por `error.code` e não por `meta.component` — todos conferem com `src/lib/providers/brave.mjs:140-156`, `:273-305`, `:347`.
- "2 skills instaladas" — `src/lib/harness-install.mjs:109-112`. (A terceira, `surf-free-agent-skill`, foi de fato deletada na v8: `:36`.)

## Afirmações sobre o HARNESS, não verificáveis neste repositório

Fora do escopo de "prompt vs. código", mas registradas porque o parent perguntou por afirmações falsas:

- `SKILL.md:28`, `:220-224`, `references/failure-modes.md:64-68`: `fork` exige `CLAUDE_CODE_FORK_SUBAGENT=1`; "os tipos embutidos são `Explore`, `Plan` e `general-purpose`". Nesta sessão o roster de agentes expõe também `claude`, `claude-code-guide` e `statusline-setup` — a lista de embutidos do prompt está desatualizada em relação ao ambiente vivo, mas isso é drift de harness, não do repositório.
- `SKILL.md:113-122` (R4): manda passar `run_in_background: false` em toda chamada `Agent`. **Esse parâmetro não existe no schema da ferramenta `Agent` desta sessão** (o schema aceita `description`, `isolation`, `model`, `prompt`, `subagent_type`). A skill antecipa o caso em `:119-122` ("Se o parâmetro não existir no schema desta sessão, não o invente") e cai para a barreira contável da R5 — o desenho está certo, mas na prática a **regra R4 é letra morta e a R5 é a única barreira que existe**. Isso importa para B-06.
- `SKILL.md:542-550` (`hard-limits`): 20 simultâneos / 200 por sessão. Não verificável aqui.

---

# B. A research tira TODAS as dúvidas? — VEREDITO

## Veredito: **PARCIAL — não, e o problema não é ela deixar dúvida aberta; é ela poder entregar sem declarar quais.**

O desenho é sério e a maior parte dele é executável: o Registro de Dúvidas
(`SKILL.md:170-207`) tem esquema tabular fixo, três invariantes numeradas,
estados terminais nomeados, e uma coluna de proveniência que o portão G4
percorre. O portão de admissão G1-G4 (`SKILL.md:376-390`) é bem melhor do que a
média do gênero: G1 é checável contra o registro, G2 exige **nomear** a parte do
entregável que muda (e a invariante I2 em `:200-202` obriga essa coluna a existir
antes), G4 é **contável** (três saltos na cadeia de origem). A decisão de não
usar juiz-por-rodada (R7 `:144-150`, C5 `:496-498`) está certa e é bem
justificada.

O que segue são os furos — cada um com a linha e a redação proposta.
**Nenhum deles foi escrito no `SKILL.md`.**

---

### B-01 — Uma dúvida respondida com confiança BAIXA conta como fechada, e o usuário nunca fica sabendo

- **Onde**: `SKILL.md:358-360` — "Registre cada handoff: resposta, **confiança**, fontes, caminho do arquivo. Marque **RESPONDIDA**, ou BLOQUEADA quando o contador de `cli-falhou` estourar."
- **O problema**: a confiança é *registrada* (coluna existe em `SKILL.md:179`; o T3 é obrigado a devolvê-la em `references/burst-templates.md:294`) e depois **não faz nada**. Não há regra que transforme `Confiança: Baixa` em ABERTA, em nova dúvida, em rajada de confiança (que existe em `SKILL.md:79-81` e é usada só na verificação), nem em ressalva no T8 — o T8 (`references/burst-templates.md:518-533`) não tem **nenhum** contador de confiança. `references/failure-modes.md:97` só reconhece "confiança baixa" quando a rajada **inteira** volta assim.
- **Consequência**: 5 dúvidas fechadas com confiança Baixa produzem uma resposta que se apresenta como completa. O único filtro é o T5 achar, por conta própria, que aquilo é "nominalmente respondida, materialmente aberta" (`SKILL.md:422-425`) — opinião de LLM sobre um sinal que já estava explícito na tabela.
- **Redação proposta** (nova regra no `<workflow>` fase 3, e um invariante no `<doubt-register>`):

  > **I4 — Confiança baixa não fecha dúvida.** Handoff que volta com
  > `Confiança: Baixa` entra no registro como **RESPONDIDA-FRACA**, não como
  > RESPONDIDA. Uma RESPONDIDA-FRACA: (a) **nunca** é usada como CONTEXTO
  > ESTABELECIDO para outro sub-agente; (b) em rajada-contínua, é
  > automaticamente re-admitida na rajada seguinte reformulada como pergunta
  > mais estreita, **sem passar pelo portão** — o portão decide sobre dúvidas
  > *novas*, não sobre reabrir uma malfeita; (c) em rajada-única, entra
  > obrigatoriamente em "Questões em aberto" com o motivo "respondida com
  > confiança baixa" e com a evidência que faltava; (d) toda afirmação da
  > resposta final que dependa dela carrega ressalva escrita, como uma
  > SOLITÁRIA. O T8 ganha a linha `Respondidas com confiança baixa {{H}}`, e
  > `{{H}} > 0` obriga a seção "Ressalvas".

---

### B-02 — C3 ("saturação de fontes") é INEXECUTÁVEL como escrita: o orquestrador não tem como saber se uma fonte é inédita

- **Onde**: `SKILL.md:486-488` — "**C3 saturação de fontes**: Pare também se uma rajada inteira não trouxe **nenhuma fonte inédita** — as buscas estão circulando no mesmo material."
- **O problema**: o orquestrador lê **resumos** (R8, `SKILL.md:151-157`). O campo `Sources` do T3 (`references/burst-templates.md:296`) é `[1] Título — URL (data) · [2] …`, com **numeração local de cada sub-agente** — o `[1]` do D3 e o `[1]` do D4 são URLs diferentes. Para avaliar C3 o orquestrador precisaria manter um conjunto acumulado de URLs normalizadas entre rajadas. **Não existe**: o esquema do `DOUBTS.md` (`SKILL.md:179`) não tem coluna de fontes, não há artefato `SOURCES.md`, e nenhum passo do workflow manda construir esse conjunto. C3 vira palpite — e é um palpite que **encerra a pesquisa**.
- **O agravante**: o dado já existe e é grátis. A CLI conta isso internamente (`src/lib/ai/orchestrator.mjs:300`, `:316-321`) e expõe em `diagnostics.uniqueSources` no `--json` (`references/surf-ai-cli.md:83-87`), que o T3 já é obrigado a passar (`references/burst-templates.md:224`).
- **Redação proposta**:

  > **C3 (saturação de fontes) — reescrita.** Depois de cada rajada, anexe a
  > `research/{{SLUG}}/SOURCES.md` uma linha por URL de todo handoff da rajada,
  > normalizada (sem esquema, sem `www.`, sem query string, sem fragmento),
  > precedida do número da rajada. C3 dispara quando
  > `|URLs distintas após a rajada N| == |URLs distintas após a rajada N-1|`.
  > É uma comparação de dois inteiros, não um julgamento. Registre os dois
  > números na tabela de rajadas do T8, coluna "Fontes inéditas".
  > Cada sub-agente T3 passa a devolver também
  > `uniqueSources` do `diagnostics` do JSON da CLI, para que a conta feche.

---

### B-03 — BLOQUEADA não tem casa na prestação de contas: uma dúvida que falhou pode sumir do relatório

- **Onde**: `references/burst-templates.md:519-525` (bloco "Doubt register" do T8) vs. `SKILL.md:165-166` (R9) e `SKILL.md:358-365`.
- **O problema**: o T8 conta `A` levantadas, `B` fechadas por contexto, `C` por busca, `G` por inferência, `D` admitidas em rajadas seguintes, `E` descartadas no portão, `F` abertas na entrega — e diz explicitamente que **"{{F}} soma dois grupos"**: as admitidas na triagem e as que estouraram o teto da rajada. `BLOQUEADA` (dúvida cuja CLI falhou duas vezes, `SKILL.md:165-166`) não é nenhum dos dois e não é nenhuma das outras letras. A prosa manda que ela "apareça como questão em aberto"; a **estrutura de contagem não tem onde pô-la**. Um modelo que preencha o T8 literalmente omite as bloqueadas.
- **Agravante estrutural**: os contadores nunca são reconciliados. `D` (admitidas em rajadas seguintes) é uma métrica de **fluxo** misturada com métricas **terminais** — uma dúvida admitida na rajada 2 vira RESPONDIDA na 2 e é contada duas vezes. Não há identidade que force o registro a fechar.
- **Redação proposta** (substitui o bloco do T8):

  > ### Registro de dúvidas
  > Levantadas **{{A}}** · fechadas pelo contexto **{{B}}** · fechadas por busca
  > **{{C}}** · fechadas por inferência do orquestrador **{{G}}** · descartadas
  > no portão **{{E}}** (inclui as DUPLICATAS) · **bloqueadas {{I}}** · abertas
  > na entrega **{{F}}**.
  >
  > **Identidade obrigatória: `A = B + C + G + E + I + F`.** Se não fechar, o
  > registro está errado — conserte o registro, nunca o número. `{{D}}`
  > (admitidas em rajadas posteriores) é métrica de fluxo, vai na tabela de
  > rajadas e **não entra na identidade**.
  >
  > `{{F}}` e `{{I}}` **têm de aparecer, linha a linha, na tabela "Questões em
  > aberto"**: `nº de linhas da tabela == F + I`.

---

### B-04 — Dúvida reprovada no portão desaparece: o usuário vê só um número

- **Onde**: `SKILL.md:396-397` — "Registre TODA candidata, inclusive as reprovadas, com o motivo da reprovação" (bom) — mas `references/burst-templates.md:521` só expõe `descartadas no portão {{E}}`, **um inteiro sem lista**.
- **O problema**: G2 ("muda uma parte concreta do entregável") e G4 ("deriva") são as duas reprovações que dependem de julgamento. Para uma skill cujo argumento de venda é "o usuário fica sabendo o que não foi respondido" (`SKILL.md:56-57`), esconder **atrás de um inteiro** a lista das perguntas que o próprio orquestrador decidiu não fazer é o elo mais fraco da cadeia. É também o incentivo errado: reprovar em G2 é o caminho mais barato para uma rajada seca (ver B-05).
- **Redação proposta** (nova seção no T8, depois de "Questões em aberto"):

  > ### Dúvidas recusadas no portão
  > | Dúvida | Portão | Motivo em uma linha |
  > Uma linha por candidata reprovada em **G2, G3 ou G4**. As reprovadas em G1
  > (duplicata) ficam só no contador, com o `Dn` de que são duplicata no
  > registro. Se a tabela ficar vazia com `{{E}} > 0`, o registro está errado.

---

### B-05 — C1/C2 confundem "não sobrou dúvida" com "não conseguimos responder": a falha se disfarça de saturação

- **Onde**: `SKILL.md:479-481` (C1) — "Rajada que termina com ZERO dúvidas admitidas no portão é uma rajada seca" — e `:482-485` (C2, k=2).
- **O problema**: o contador mede **admissões**, não **respostas**. Uma rajada em que 4 de 5 dúvidas voltaram BLOQUEADAS e a 5ª voltou fraca produz naturalmente zero candidatas admissíveis (dúvida nova nasce de *resposta*, `SKILL.md:373-375`). Isso conta como **seca**. Duas assim seguidas = `SATURADO` → fase 5 → entrega. **O sistema conclui "esgotamos o assunto" quando o que aconteceu foi "não conseguimos pesquisar".** O `references/failure-modes.md:99-104` cobre o caso extremo (rajada 100% vazia não conta como seca) e é justamente a prova de que o caso parcial ficou de fora.
- **Sobre "a paciência k=2 é checável?"**: **sim** — é um contador inteiro com regra de zeragem explícita (`SKILL.md:480-481`), e é o pedaço mais sólido da convergência. O problema não é a paciência; é **o que ela conta**.
- **Redação proposta**:

  > **C1 (rajada seca) — reescrita.** Uma rajada só pode ser marcada como seca
  > se **pelo menos metade das dúvidas disparadas nela voltou RESPONDIDA com
  > confiança Média ou Alta**. Abaixo disso a rajada é **estéril**, não seca:
  > não incrementa o contador de secas, e dispara `rajada-vazia`
  > (`references/failure-modes.md`) — reformular e re-disparar, no máximo 2
  > vezes. Uma pesquisa **nunca** converge por saturação enquanto o motivo de
  > não haver dúvida nova for não haver resposta. Estéril duas vezes seguidas
  > = pare, mas o motivo de parada no T8 é
  > **"pesquisa impedida (rajadas estéreis)"**, jamais "saturação".

---

### B-06 — A barreira da R5 não tem artefato: é memória do modelo entre turnos

- **Onde**: `SKILL.md:129-134` — "a barreira é CONTÁVEL — você marcou N dúvidas como EM-VOO; não triaga … enquanto não tiver recebido N conclusões".
- **O problema**: neste harness o `run_in_background: false` da R4 **não existe no schema da ferramenta `Agent`** (ver seção A, "afirmações sobre o harness"), então a barreira contável é a *única* que existe — e o `SKILL.md` a define como um estado que o modelo carrega na cabeça através de vários turnos com notificações chegando fora de ordem. O status `EM-VOO` existe (`SKILL.md:188`) mas nada manda **reler** o `DOUBTS.md` para recontar antes de triar. A fase 4 (`SKILL.md:369-372`) começa direto em "Junte todas as dúvidas novas".
- **Redação proposta** (passo 0 da fase 4 + linha fixa no topo do `DOUBTS.md`):

  > O `DOUBTS.md` abre com a linha de barreira, reescrita a cada disparo e a
  > cada retorno:
  > `<!-- BARREIRA rajada N: em-voo=5 recebidos=2 -->`
  > **Primeiro passo da fase 4, antes de qualquer julgamento:** releia essa
  > linha no arquivo. Se `recebidos < em-voo`, você não está na fase 4 — volte
  > a esperar. Turno sem notificação nova é espera, não permissão.

---

### B-07 — `RESPONDIDA-INFERIDA` é a válvula de escape mais larga da skill, e não tem trava

- **Onde**: `SKILL.md:233-237` (`<spawn-threshold>`) — "Dúvida cuja resposta cabe em uma linha e que você já sabe **com certeza** não precisa de sub-agente: responda inline e registre como RESPONDIDA-INFERIDA."
- **O problema**: "eu já sei com certeza" é auto-avaliação de um LLM sobre o próprio conhecimento, aplicada a uma skill cuja razão de existir é que o conhecimento do modelo é velho e não é citável. Não há teto, não há tipo de dúvida proibido, e uma INFERIDA vira CONTEXTO ESTABELECIDO para os sub-agentes seguintes (`SKILL.md:320-321`) — propagando um palpite como fato dado. O crédito devido: o T8 **lista** as inferidas ("Premissas inferidas sem consultar ninguém", `references/burst-templates.md:535-537`), o que é mais honesto que a média. Falta a trava.
- **Redação proposta**:

  > **RESPONDIDA-INFERIDA é proibida** quando a resposta contiver um número, uma
  > versão, um preço, uma data, um limite, um nome de API, ou quando a
  > afirmação for carregar uma citação `[n]` no entregável. Essas viram
  > sub-agente, sempre — são exatamente as que envelhecem. Teto: no máximo
  > **20% das dúvidas levantadas** podem fechar como INFERIDA; da 21ª em
  > diante, dispare. Uma INFERIDA **nunca** entra no CONTEXTO ESTABELECIDO
  > sem a etiqueta `(inferido, não verificado)`.

---

### B-08 — Sob `teto-de-sessão`, o orquestrador vira auditor de si mesmo

- **Onde**: `references/failure-modes.md:91-93` — "Nesse estado as fases de verificação e síntese também não podem gastar sub-agente: **faça T4, T5 e T6 você mesmo, inline**, e declare no relatório final que rodaram sem sub-agente."
- **O problema**: o T4 é definido como "revisor adversarial com **ZERO contexto**" (`references/burst-templates.md:319`) e o T5 existe justamente para pegar o que o orquestrador não viu (`:363-366`). Rodados inline pelo agente que tomou todas as decisões de fechamento, os dois perdem a propriedade que os torna úteis. A degradação está **declarada** (bom), mas está declarada como se fosse equivalente — e é o único caminho do workflow em que **nenhuma** verificação independente sobrevive.
- **Redação proposta**: manter o fallback (é melhor que nada), mas rebaixar o resultado explicitamente:

  > Quando T4/T5 rodam inline, **toda** afirmação da resposta final desce um
  > nível de confiança e o T8 declara, em "Verificação":
  > `sem revisão independente (teto de sessão) — verificação auto-aplicada`.
  > O veredito `PRONTO PARA SÍNTESE` produzido inline **não** autoriza fechar
  > dúvida alguma que estivesse ABERTA: nesse estado o ramo de correção da
  > fase 5 não existe e tudo que faltava vai para "Questões em aberto".

---

### B-09 — Nada obriga o `DOUBTS.md` a estar fresco quando o T5 e o T6 o leem

- **Onde**: `SKILL.md:299` ("Publique `research/{{SLUG}}/DOUBTS.md`") e `SKILL.md:174` ("é reescrito depois de cada rajada") vs. `references/burst-templates.md:379-380` (T5 recebe `{{DOUBT_REGISTER}}`) e `:434-435` (T6 recebe `{{DOUBT_REGISTER}}`).
- **O problema**: T5 e T6 recebem o registro **colado no prompt** pelo orquestrador, não como caminho de arquivo. Se o orquestrador drifta e mantém o registro na cabeça (o que é exatamente o que acontece depois de 4 rajadas), o auditor audita a lembrança e o sintetizador sintetiza a lembrança. A única leitura de arquivo obrigatória do T6 é a dos handoffs (`references/burst-templates.md:437-439`), não a do registro. Não existe, em lugar nenhum do workflow, uma varredura determinística de "toda linha do registro tem status terminal antes da síntese".
- **Redação proposta** (fase 5, antes de emitir T4/T5; e T5/T6 passam a receber caminho, não conteúdo):

  > **Portão de síntese (fase 5, passo 0).** Releia `research/{{SLUG}}/DOUBTS.md`
  > do disco e verifique, linha a linha: nenhuma dúvida em `EM-VOO`; toda
  > dúvida `ABERTA` ou `BLOQUEADA` tem preenchido o campo "o que a fecharia";
  > a identidade `A = B + C + G + E + I + F` fecha. Só então emita T4 e T5.
  > Os templates T5 e T6 recebem **o caminho** `research/{{SLUG}}/DOUBTS.md` e
  > são instruídos a lê-lo — nunca uma cópia colada.

---

### Respostas diretas às perguntas do parent

| Pergunta | Resposta |
|---|---|
| O `DOUBTS.md` e o portão G1-G4 estão especificados de forma **executável**? | **G1, G2 e G4: sim** — G1 é comparação contra o registro (`SKILL.md:377-379`), G2 exige nomear a parte do entregável e a I2 (`:200-202`) obriga a coluna a existir, G4 é contagem de saltos na cadeia de origem via I3 (`:203-206`). **G3: não** — "existe evidência que plausivelmente a feche" (`:383-386`) é previsão sobre o mundo, feita antes de olhar. A lista de reprovação que a acompanha ("futuro", "intenção de terceiros") é boa, mas está redigida como *exemplo*, não como *taxatividade*. **Correção proposta:** "G3 só reprova por uma destas causas, e o motivo registrado tem de nomear qual: (a) evento futuro; (b) intenção de terceiro; (c) dado privado não publicado; (d) a pergunta não é factual. Fora dessas quatro, **na dúvida, ADMITA** — o custo de uma dúvida a mais é um sub-agente; o de uma a menos é uma resposta errada." O **registro** em si é executável: esquema fixo, estados nomeados, três invariantes numeradas. Falta o que B-06 e B-09 pedem — obrigação de reler o arquivo. |
| Existe caminho para ENTREGAR com dúvida ABERTA **sem declará-la**? | **Sim, cinco.** (1) BLOQUEADA sem casa no T8 — B-03. (2) Confiança baixa marcada como RESPONDIDA — B-01. (3) Reprovada em G2/G4 vira um inteiro — B-04. (4) Registro desatualizado chegando ao T5/T6 — B-09. (5) T4/T5 inline sob teto de sessão — B-08. |
| O "Questões em aberto" do modo rajada-única é suficiente? | **Não.** Ele cobre bem o caso para o qual foi desenhado — as **admitidas na triagem** (`SKILL.md:399-401`) e as **excedentes do teto** (`:332-336`), ambas com "o que a fecharia". Mas os cinco caminhos acima passam por fora dele. Suficiente **depois** de B-01, B-03 e B-04; hoje, não. |
| C1-C6 pode terminar cedo demais? | **Sim, por um caminho concreto: B-05** — rajada impedida conta como seca. Fora dele, o desenho é conservador na direção certa: C2 exige duas secas, C4 estende o teto de 6 para 12 quando ainda há admissões, e C6 (`SKILL.md:499-502`) manda o sintetizador ler o registro inteiro. C6 é, aliás, a regra mais bem calibrada do arquivo. |
| "Paciência k=2" e "saturação de fontes" são checáveis ou opinativas? | **k=2 é checável** (contador inteiro, regra de zeragem explícita em `SKILL.md:480-481`). **Saturação de fontes é opinativa hoje** e não deveria ser — o dado existe de graça no `--json` da CLI. Ver B-02. |
| Dúvida respondida com confiança BAIXA conta como fechada? | **Sim, integralmente.** `SKILL.md:358-359` marca RESPONDIDA sem olhar a confiança; a coluna Confiança (`:179`) não é lida por nenhuma regra posterior; o T8 não tem contador de confiança. Ver B-01. |
| Falta mecanismo para o usuário saber QUAIS dúvidas ficaram sem resposta e por quê? | **Parcialmente presente, e é o melhor pedaço da skill** — a tabela "Questões em aberto" com a coluna "o que a fecharia" (`references/burst-templates.md:539-540`, `:468-469`) é exatamente o mecanismo certo. O que falta é a **obrigação de que ela feche a conta**: a identidade de B-03 (`nº de linhas == F + I`) e a tabela de recusadas de B-04. |

---

# C. Especificação da skill de BUSCA NORMAL

## C.1 — Por que ela falta: o piso de custo da research é fixo e alto

Nenhuma fase do workflow da research é opcional para pergunta pequena:

| Fase | Linha | Obrigatoriedade |
|---|---|---|
| Rajada 0 (contexto) | `SKILL.md:303-305` | "Roda nos DOIS modos, **sempre. Nunca pule.**" → 2 sub-agentes (T1 fork + T2 Explore) |
| Rajada 1 (dúvidas) | `SKILL.md:325-326` | "Rajada 1 nos dois modos" → ≥1 sub-agente |
| Verificação | `SKILL.md:409-419` | T4 + T5 "NA MESMA MENSAGEM" → 2 sub-agentes |
| Síntese | `SKILL.md:443-446` | "UM sub-agente sintetizador (T6). Nunca dois." → 1 sub-agente |
| Entrega + commit | `SKILL.md:454-471` | cria `research/{{SLUG}}/` e faz `git commit` |

**Piso: 6 sub-agentes, 3 artefatos em disco (`DOUBTS.md`, `FINDINGS.md`,
`ANSWER.md`) e um commit no repositório do usuário — para qualquer pergunta.**

A própria skill sabe que isso é desproporcional e diz duas vezes, sem ter como
agir: `SKILL.md:507-508` ("fato simples: 1 sub-agente … **ou nenhum**, se você
já sabe") e `SKILL.md:562-565` ("orquestração multi-agente custa 3-10x os tokens
… para uma dúvida trivial, cinco sub-agentes é desperdício"). O único escape
hoje é o `<spawn-threshold>` (`SKILL.md:233-237`) — fechar tudo como
`RESPONDIDA-INFERIDA` —, que é justamente a válvula sem trava de B-07. **O
caminho barato que a skill oferece é o caminho que não pesquisa.**

Contexto histórico: a v7 tinha uma terceira skill, `surf-free-agent-skill`
(Wikipedia/DuckDuckGo sem chave), **deletada na v8**
(`src/lib/harness-install.mjs:36`). O nicho raso ficou vago; a research herdou
os gatilhos dele e não herdou a leveza.

## C.2 — Gatilhos que hoje caem na research e deveriam cair na rasa

`SKILL.md:13-16` mistura, na mesma lista, verbos genéricos e verbos de
totalidade:

| Gatilho atual (`SKILL.md:13-16`) | Onde deveria cair |
|---|---|
| `pesquise`, `investigue`, `busca na web`, `search the web`, `research`, `investigate` | **RASA** — genéricos; disparam em "pesquisa qual a versão atual do Node LTS" |
| `compare X e Y`, `compare X vs Y` | **Depende do escopo.** Comparação de 2 itens em 1 eixo é rasa. É a fronteira, e precisa de critério explícito (ver C.4) |
| `ache tudo sobre`, `find everything about`, `levantamento completo`, `pesquisa profunda`, `deep dive` | **RESEARCH** — pedem totalidade. Corretos onde estão |

## C.3 — O que cada binário já entrega (base para a especificação)

| Binário | Requisitos | O que faz | O que devolve | Custo |
|---|---|---|---|---|
| `surf-research-skill search "q"` (`bin/surf-research-skill.mjs:236-249`) | Chave Brave (portão em `:663`; `search` **não** está em `NO_KEYS_NEEDED`, `:658-662`) | 1 request Brave por query. **Batch de N positionals roda SEQUENCIALMENTE** (chamada em `:249`, comentário em `:246-248`) | SERP cru: título, URL, `description` + até 5 `extra_snippets`, `page_age`. **Sem LLM, sem síntese, sem citação.** Markdown ou `--json` | N requests |
| `surf-research-skill search-parallel` (`:699`) | idem | Leque concorrente, `--sub-agents`, `--queries-file` | idem, em lote | N requests |
| **`surf-search-normal`** (`bin/surf-search-normal.mjs`) | Chave Brave (`:111` `preflightOrExit`) + OpenRouter (degrada sem, `src/lib/ai/orchestrator.mjs:246-251`, `:466-469`) | 1 chamada LLM de plano → 1 onda de até 10 buscas Brave → 1 chamada LLM de síntese (`src/lib/ai/orchestrator.mjs:65-66`, `:333`) | **Resposta sintetizada com `[n]`, tabela de fontes e `diagnostics`** (`references/surf-ai-cli.md:78-89`) | ≤10 requests + 2 LLM · 45-110 s |
| `surf-search-unlimit` | idem | Até `--max-rounds` ondas com análise de lacuna entre elas | idem, mais profundo | ondas × sub-agents · 2-15 min |

**Conclusão para o desenho**: o motor da skill rasa é **`surf-search-normal`**,
não o `search` cru — ele já entrega, em uma chamada e sem nenhum sub-agente,
exatamente o produto de uma busca rasa boa: resposta citada + fontes. O `search`
cru é o modo secundário (só links, ou filtros Brave diretos, ou quando a resposta
desejada É a lista de resultados).

## C.4 — ESPECIFICAÇÃO

### Nome

**`surf-search-agent-skill`**

Espelha a nomenclatura já existente do pacote (`surf-search-normal` /
`surf-search-unlimit` são busca; `surf-research-*` é pesquisa) e completa a
tríade `search · research · plan`. **Risco assumido e mitigado**: para um
roteador de skills, "search" e "research" são lexicalmente próximos demais — a
desambiguação **não pode** ficar por conta do nome, tem de estar inteira na
`description` (C.5). Alternativas descartadas: `surf-quick-search-agent-skill`
(longo, e "quick" convida a usar por pressa, não por escopo);
`surf-answer-agent-skill` (não diz que é web).

### Frontmatter proposto

```yaml
---
name: surf-search-agent-skill
description: >-
  Busca web de UMA pergunta, respondida e citada, sem orquestração. Uma chamada
  de surf-search-normal (Brave Search, e nada mais), a resposta em até 10 linhas
  com citações [n] e a tabela de fontes. Sem sub-agentes, sem registro de
  dúvidas, sem arquivos, sem commit. Use quando a pergunta tem UMA resposta
  verificável e o usuário quer ela agora: um número, uma versão, uma data, um
  limite, um preço, um erro, "isso ainda é verdade?", "como se faz X", "qual a
  diferença entre A e B". Triggers: pesquise, busca rápida, procura na web,
  me acha, qual a versão de, ainda existe, isso mudou, quanto custa,
  search the web, look this up, quick search, what is, how do I, is X still.
  Para o Brave. Sem chave Brave válida sai 78 e esta skill PARA — não há
  provedor alternativo nem WebSearch de reserva.
  NÃO use quando a resposta exigir mais de uma pergunta independente, quando o
  usuário pedir levantamento, panorama, "tudo sobre", "deep dive", comparação
  de 3+ opções ou de 2 opções em vários eixos, ou quando a decisão for cara de
  reverter — nesses casos use surf-research-agent-skill. NÃO use para planejar
  execução (surf-plan-agent-skill), nem para arquivos locais, git ou código.
  NÃO use para ler uma URL específica: o Brave devolve links e trechos, nunca
  o conteúdo da página.
license: MIT
argument-hint: "a pergunta — opcionalmente links-only"
allowed-tools: Bash(surf-search-normal:*), Bash(surf-research-skill search:*), Bash(surf-research-skill search-parallel:*), Read
model: inherit
effort: medium
metadata:
  version: "8.1.0"
  requires: "node>=18; npm i -g surf-agent-skill; chave Brave VÁLIDA (surf ou surf-research-skill keys add --provider brave <key>) — sem ela todo comando sai 78; chave OpenRouter (surf-research-skill ai-setup) recomendada: sem ela a CLI degrada para modo evidência, sem síntese"
---
```

Notas de desenho do frontmatter, cada uma com motivo:

- **`allowed-tools` sem `Agent` e sem `Task`.** É a garantia *estrutural* de que
  a skill rasa não pode se transformar em orquestrador. A fronteira deixa de
  depender da disciplina do modelo.
- **`allowed-tools` sem `WebSearch`/`WebFetch`.** Mantém a invariante Brave-only
  da v8 (`src/lib/preflight.mjs:1-6`) — e evita repetir o furo A-06 da plan-skill.
- **`allowed-tools` sem `Write`, sem `Bash(git:*)`, sem `Bash(mkdir:*)`.** A skill
  rasa não deixa rastro em disco. Isso *é* parte da definição dela.
- **`effort: medium`**, contra o `xhigh` da research (`SKILL.md:24`).
- **`requires` nomeia a chave Brave em primeiro lugar** — a lição de A-07.

### Quando usar / quando NÃO usar — a FRONTEIRA

O critério é **um só, e é observável antes de qualquer busca**:

> **Quantas perguntas independentes a resposta exige?**
> **Uma → rasa. Mais de uma, ou você não sabe → research.**

Não é "quão importante é", não é "quão rápido eu quero" e não é "quão difícil
é" — esses são opinativos e cada um puxa para um lado. "Quantas perguntas
independentes" é contável na hora, e é exatamente o eixo em que as duas skills
diferem: a research existe para **decompor** (`SKILL.md:271-301`); a rasa existe
para o caso em que não há o que decompor.

| Sinal | Rasa | Research |
|---|---|---|
| A resposta cabe em uma frase verificável (número, versão, data, limite, preço, sim/não) | ✅ | |
| O usuário quer agora e vai agir na sequência | ✅ | |
| Comparar 2 opções em **um** eixo ("qual é mais rápido") | ✅ | |
| Comparar 3+ opções, ou 2 opções em vários eixos | | ✅ |
| A pergunta tem "tudo", "completo", "panorama", "todas as opções", "deep dive" | | ✅ |
| A resposta depende de **contexto do projeto** (versão do runtime, o que já foi tentado) | | ✅ (rajada 0 existe para isso) |
| A decisão é cara de reverter (escolha de banco, de licença, de arquitetura) | | ✅ |
| O usuário quer o **rastro** — o que foi perguntado, o que ficou aberto | | ✅ |
| O usuário quer só a lista de links | ✅ (modo links) | |

### O fluxo (5 passos, nenhum sub-agente)

1. **Reformular em uma linha e nomear a forma da resposta.** "Uma frase",
   "uma tabela de 2 linhas", "um comando". Se, ao escrever isso, você precisar
   de um "e" ligando duas perguntas independentes → **PARE e escale** (passo 5c).
2. **Uma chamada. Sem portão prévio.** Não rode `surf-research-skill keys list`
   antes — ele não valida nada e não sai 78 (achados A-04/A-05). O portão real é
   o `preflightOrExit` do próprio binário (`bin/surf-search-normal.mjs:111`).

   ```bash
   surf-search-normal "<a pergunta>" \
     --task "<o que a pessoa está fazendo>" \
     --goal "<a decisão que isto alimenta>" \
     --insights "<o que ela acredita — vira hipótese a falsificar>" \
     --deliverable "<a forma exata da resposta>" \
     --json
   ```
   Timeout de Bash: **180000 ms**. Modo links-only (sem LLM, 1 request):
   `surf-research-skill search "<q>" --max 5 --json`.
3. **Ler os três sinais antes de acreditar** (`references/surf-ai-cli.md:93-101`):
   `diagnostics.queriesFailed` > 0 → cobertura mais fina, rebaixe a confiança;
   aviso de estágio degradado → o LLM caiu para o plano determinístico
   (`src/lib/ai/heuristics.mjs:125-128`), a resposta é evidência, não síntese;
   motivo da parada.
4. **Responder em até 10 linhas**, com `[n]` e a tabela de fontes, mais três
   coisas obrigatórias, nessa ordem: a **confiança** (Alta/Média/Baixa) com o
   motivo em uma frase; **o que NÃO foi checado**; a **data** da fonte mais
   recente, quando a resposta for do tipo que envelhece.
5. **Escalar em voz alta, nunca em silêncio.** Diga "isto pede a
   `surf-research-agent-skill`, quer que eu rode?" — e pare — quando qualquer
   destes acontecer:
   (a) a resposta veio com **confiança Baixa**; (b) as fontes **se contradizem**;
   (c) fechar a pergunta exigiria uma **segunda pergunta independente**;
   (d) a resposta depende de algo do **projeto/conversa** que você não tem;
   (e) o usuário indicou que a **decisão é difícil de reverter**.
   **Uma tentativa só**: se a CLI falhar por qualquer motivo que não seja 78,
   tente exatamente mais uma vez com `--max 3`; falhando, diga que falhou. Se
   sair **78**, devolva a mensagem do portão **verbatim** e pare — não há plano
   B (`src/lib/preflight.mjs:199-209`).

### O que ela NÃO faz — e é por isso que a research existe

Esta lista é o contrato de fronteira; cada item é uma coisa que a research
faz e ela não:

| Não faz | Onde vive na research |
|---|---|
| Não levanta dúvidas nem mantém registro | `SKILL.md:170-207`, `:271-301` |
| Não dispara sub-agente nenhum (não tem `Agent`/`Task` no `allowed-tools`) | `SKILL.md:100-107` (R3) |
| Não faz rajada de contexto (fork do chamador / Explore do repositório) | `SKILL.md:303-323` |
| Não tem portão de admissão nem triagem | `SKILL.md:369-407` |
| Não tem verificação adversarial nem auditoria de cobertura | `SKILL.md:409-441` |
| Não tem sintetizador separado | `SKILL.md:443-452` |
| Não cria `research/{{SLUG}}/` nem commita nada | `SKILL.md:266-267`, `:454-471` |
| Não tem modo contínuo, convergência ou teto de rajadas | `SKILL.md:477-503` |
| Não faz mais de uma chamada de busca (salvo a única retentativa) | `SKILL.md:517-539` |
| Não lê o conteúdo de uma página — só o que o Brave devolve | `references/brave-api.md:185` |

## C.5 — Como as duas evitam se canibalizar

Três travas independentes. Uma só não segura, porque a decisão de roteamento é
tomada por um LLM lendo duas `description` parecidas.

1. **Editar a `description` da research, não só adicionar a nova.** Enquanto
   `SKILL.md:13-16` mantiver `pesquise`, `investigue`, `busca na web`,
   `search the web`, `research` e `investigate`, as duas skills disputam a mesma
   frase e a mais específica perde. Proposta de redação para os gatilhos da
   research:

   > `Triggers on: ache tudo sobre, levantamento completo, pesquisa profunda,
   > panorama de, todas as opções de, compare X, Y e Z, deep dive, find
   > everything about, exhaustive research, "não deixe nada em aberto".`
   > `Para UMA pergunta com UMA resposta, use surf-search-agent-skill — esta
   > skill dispara no mínimo 6 sub-agentes e escreve arquivos, e isso é
   > desperdício para uma pergunta fechada.`

2. **Nomeação recíproca explícita.** Cada `description` cita a irmã pelo nome
   no bloco "NÃO use quando" (já embutido na proposta acima e em C.4). É o que a
   research já faz bem com a plan-skill (`SKILL.md:17-18`), e o padrão funciona.

3. **Uma partição em UM eixo observável, nunca dois.** A fronteira é
   *"quantas perguntas independentes"*, e só. Nenhuma das duas `description`
   deve mencionar velocidade, importância ou dificuldade como critério — são os
   eixos que produzem empate e fazem o roteador escolher pela última linha que
   leu.

**Simetria obrigatória**: a rasa escala **para cima** só falando (passo 5c da
C.4), nunca invocando a research por conta própria; e a research, ao concluir na
fase 0 que a pergunta tem uma única dúvida WEB e nenhuma dúvida de contexto,
deve poder dizer "isto era caso de `surf-search-agent-skill`" e rodar a rajada
mínima em vez do piso de 6. Sem essa segunda metade, a research continua sendo o
default de tudo que soar como pesquisa.

---

## Apêndice — método e limites desta auditoria

- **Zero rede.** Nenhuma chamada Brave, nenhum `surf`, nenhum `WebSearch`.
  Só leitura de arquivos da worktree.
- **Não executei o código.** As afirmações de comportamento vêm de leitura de
  fonte, com linha citada. Onde o comportamento depende do harness (fork mode,
  `run_in_background`, tetos de sub-agente), separei numa seção própria em vez
  de chamar de falso.
- **Não editei nada** sob `test/`, `src/`, `bin/`, `SKILL.md`, `skills/`,
  `references/`, `package.json`. Toda redação proposta está neste arquivo.
- **Cobertura**: `SKILL.md` (650 linhas), `skills/surf-plan-agent-skill/SKILL.md`
  (701), `references/` (6 arquivos, 1.556 linhas) lidos integralmente ou nas
  seções relevantes; `src/lib/ai/{orchestrator,cli,openrouter,heuristics}.mjs`,
  `src/lib/{flags,preflight,keys-cmd,cache,ratelimit,dispatch,harness-install}.mjs`,
  `src/lib/providers/brave.mjs`, `src/install/postinstall.mjs` e os 5 bins.
