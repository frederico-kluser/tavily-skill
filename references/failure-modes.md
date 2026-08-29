# Modos de falha — surf-research-agent-skill v7

Leia o caso quando o sintoma aparecer. O `SKILL.md` traz só o índice.

## Índice

| Caso | Sintoma em uma linha |
|------|----------------------|
| `cli-falhou` | Sub-agente voltou sem handoff utilizável por causa do surf-search-* |
| `handoff-sem-payload` | Sub-agente terminou com sucesso e não devolveu o formato |
| `fork-indisponível` | `Agent type 'fork' not found` — modo fork desligado |
| `teto-de-sessão` | `Subagent spawn limit reached` — 200 sub-agentes na sessão |
| `rajada-vazia` | Rajada inteira voltou sem achado ou com confiança baixa em tudo |
| `deriva-de-dúvida` | As dúvidas novas já não falam da pergunta original |
| `irmãos-incompatíveis` | Dois handoffs da mesma rajada não podem ser ambos verdadeiros |
| `web-contradiz-projeto` | O achado na web contradiz o contexto local |
| `cascata-de-refutação` | O revisor adversarial refutou mais de 30% das afirmações |
| `commit-bloqueado` | O commit final não pode ser feito |

---

## `cli-falhou`

**Sintoma.** Sub-agente voltou SEM handoff utilizável por causa do
`surf-search-*` — ele mesmo morreu, estourou o timeout do harness, ou devolveu
só a mensagem de erro.

Não existe mais handoff FALLBACK. A v8 é Brave-only: se a CLI não respondeu, a
dúvida fica BLOQUEADA. Um sub-agente que contorne a CLI com WebSearch/WebFetch
traz uma fonte que não entra no ledger e não pode ser citada — trate como
BLOQUEADA e siga — não re-dispare.

**Antes de qualquer outra coisa, olhe o código de saída.** Se for **78**, não é
este caso: não há chave Brave válida. Pare a pesquisa inteira, devolva a
mensagem do portão verbatim e encerre — nenhum sub-agente vai conseguir, e
disparar mais só multiplica o mesmo erro. Ver `chave-brave-inválida` na
`degradation` da SKILL.md.

**Ação.** O T3 (regra 3) já mandou o sub-agente tentar `--max-queries 4`.
**Nunca prescreva isso de novo.** Bifurque:

- Ele morreu ANTES de rodar a escada (exit 143, timeout do harness, spawn
  falho): a falha foi do processo, não da dúvida. Re-dispare o MESMO prompt uma
  vez, com `surf-search-normal` e timeout maior.
- Ele rodou a escada inteira e ainda assim voltou vazio: repetir o mesmo prompt
  é garantia de repetir a falha. Re-dispare só se a dúvida der para estreitar ou
  dividir, com a pergunta reformulada; se não der, BLOQUEADA já aqui.

Conte apenas os DISPAROS SEUS, nunca as tentativas internas do sub-agente. Na
segunda vez que um disparo volta sem handoff utilizável, a dúvida vira
BLOQUEADA e aparece como questão em aberto.

## `handoff-sem-payload`

**Sintoma.** Sub-agente terminou com sucesso mas não devolveu o formato de
saída do template.

**Ação.** Sucesso sem payload utilizável é falha. Conte como disparo no mesmo
contador do `cli-falhou` e re-dispare com o formato de saída repetido no fim do
prompt.

## `fork-indisponível`

**Sintoma.** A chamada `Agent` com `subagent_type: "fork"` voltou
`Agent type 'fork' not found. Available agents: ...` — o modo fork está
desligado neste harness. O tipo `fork` depende de `CLAUDE_CODE_FORK_SUBAGENT=1`
ou de rollout escalonado; os tipos embutidos são `Explore`, `Plan` e
`general-purpose`.

**Ação.** Uma tentativa só. Não repita, e **não troque por outro tipo** —
nenhum sub-agente fresco enxerga a sua conversa. Você está DENTRO dela: produza
o payload do T1 inline, você mesmo, no formato de saída do template, e trate-o
como um handoff normal. O probe PROJECT (Explore) segue valendo e já foi
disparado. Conclua a rajada de contexto com os dois resultados e siga.

Registre `Via=INLINE` no registro, e a dúvida fechada por essa via entra com
origem CALLER-INLINE — **nunca** como INFERIDA: a R2 distingue "o chamador
disse" de "eu inferi", e colapsar as duas apaga a premissa que a R2 manda
declarar. Declare no T8 que o probe do chamador rodou inline.

## `teto-de-sessão`

**Sintoma.** O spawn falhou com `Subagent spawn limit reached` — 200
sub-agentes nesta sessão. Sub-agente concluído continua contando e só `/clear`
zera a conta; este teto **não se recupera sozinho**.

**Ação.** Não confunda com `Concurrent subagent limit reached`, que é o teto de
20 simultâneos e volta sozinho assim que um irmão termina. Aqui, enfileirar na
rajada seguinte nunca funciona: **pare de disparar rajadas**. Feche com suas
próprias ferramentas o que ainda der, marque o resto como BLOQUEADA e vá para a
verificação. Nesse estado as fases de verificação e síntese também não podem
gastar sub-agente: faça T4, T5 e T6 você mesmo, inline, e declare no relatório
final que rodaram sem sub-agente por estouro do teto de sessão.

## `rajada-vazia`

**Sintoma.** Rajada inteira voltou sem achado, ou com confiança baixa em tudo.

**Ação.** As dúvidas estavam largas ou mal formuladas. Reescreva-as mais
específicas e re-dispare — isto é **retentativa da MESMA rajada**, não uma
rajada nova: não incrementa o contador de rajadas (C4 e a tabela do T8), não
conta como seca (C1) e não viola a rajada-única. Vale o teto da R9: no máximo 2
tentativas. Persistindo, marque "sem dados públicos disponíveis" — e não
invente.

## `deriva-de-dúvida`

**Sintoma.** As dúvidas novas se afastaram da pergunta original — cadeia de
origem longa, "por que" sobre "por que".

**Ação.** O portão G4 existe para isso. Se três dúvidas seguidas de uma mesma
cadeia forem reprovadas, descarte a cadeia inteira e registre o descarte.

## `irmãos-incompatíveis`

**Sintoma.** Dois handoffs da mesma rajada chegam com conclusões que não podem
ser ambas verdadeiras.

**Ação.** A decisão é SUA, não deles — sub-agentes paralelos não se enxergam e
cada um decidiu implicitamente algo que o outro contradiz. Não peça a eles que
se acertem. Se os resumos não bastarem para julgar, abra os handoffs completos
em disco. Registre a contradição como dúvida nova de alta prioridade e resolva
na ordem: mais recente > mais primária > corroborada por 2+ fontes
independentes.

## `web-contradiz-projeto`

**Sintoma.** O achado na web contradiz o contexto do projeto ou do chamador.

**Ação.** Não escolha um lado sozinho. O contexto local normalmente vence — ele
é o terreno onde a resposta será usada —, mas a contradição vai explícita na
resposta final. Costuma ser o achado mais valioso da pesquisa.

## `cascata-de-refutação`

**Sintoma.** O revisor adversarial refutou mais de 30% das afirmações.

**Ação.** Viés sistemático nas fontes: o problema é a formulação das dúvidas,
não uma afirmação isolada. As REFUTADAS seguem o tratamento normal da
verificação (saem ou são corrigidas com a evidência do T4) **nos dois modos**.
Sobre o viés: se o modo for rajada-contínua e o número de rajadas ainda estiver
abaixo do teto vigente, dispare uma rajada de correção com as dúvidas
reformuladas para incluir a contraposição explicitamente ("desvantagens de X",
"críticas a Y", "por que não usar X"). Em rajada-única, **não abra outra
rajada**: registre "contraposição não pesquisada" como questão em aberto, com
essas buscas listadas como o que a fecharia, e marque a ressalva de viés
sistemático no relatório final.

## `commit-bloqueado`

**Sintoma.** O pré-voo reprovou (sem repositório, exit 128; ou caminho
ignorado, `git check-ignore` exit 0), ou o `git commit` saiu ≠ 0: hook
recusando ("commitlint: type must be one of…"), "Author identity unknown",
"nothing to commit".

**Ação.** O commit é o último passo, não o entregável. **NUNCA force**: nada de
`git add -f` — mesmo que o próprio git sugira `-f` na mensagem de erro —, nada
de `git init` num diretório que não é repositório, nada de `--no-verify`: o
hook é do dono do projeto, não seu. Se a recusa veio de hook de mensagem, tente
UMA única vez com a mensagem em conventional commit (`docs(research): …`).
Qualquer outra falha, ou a segunda recusa, encerra a tentativa.

Em todos os casos: mantenha os artefatos em `research/{{SLUG}}` em disco, siga
para o relatório final, e registre no T8 "Artefatos não commitados: {{MOTIVO}}".
Resposta entregue com os arquivos em disco e o motivo declarado **não é**
entregar metade.
