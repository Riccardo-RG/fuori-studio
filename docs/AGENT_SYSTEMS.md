# Sistemi di agenti: contesto per Fuori Studio

Ricognizione documentale del **27 settembre 2026**, basata su documentazione e repository ufficiali consultati online. Serve come base per le prossime domande sul prodotto: non è una classifica, una scelta di stack o una verifica pratica dei sistemi. Non sono stati installati né collegati servizi. Le pagine correnti possono precedere o seguire la versione effettivamente installabile: prima di un'integrazione vanno fissate versione, modalità di hosting e funzionalità del relativo adattatore.

## 1. I livelli da distinguere

“Multi-agente” può indicare cose diverse: più personaggi nella stessa conversazione, sottoprocessi con contesti separati, un workflow di agenti oppure un'organizzazione che conserva incarichi e responsabilità per settimane. La presenza di più nomi in chat non dimostra da sola gli altri livelli.

| Sistema | Oggetto centrale | Livello prevalente | Relazione con Fuori Studio |
|---|---|---|---|
| **Paperclip** | Organizzazione, agente, issue, obiettivo, heartbeat | Pannello di controllo e gestione del lavoro persistente | Riferimento per trasformare il team visibile in incarichi, responsabilità e risultati verificabili |
| **Codex CLI/app** | Chat/thread, turni, workspace, subagenti | Ambiente operativo per svolgere lavoro, anche con delega parallela | Motore già vicino all'app; dispone già di capacità multi-agente |
| **CrewAI** | Agent, Task, Crew, Flow | Framework Python; AMP aggiunge una piattaforma operativa | Riferimento per ruoli specializzati e processi misti, deterministici e autonomi |
| **LangGraph / LangSmith** | Grafo, stato, thread, checkpoint, run | Runtime di orchestrazione; piattaforma di osservabilità e deploy | Riferimento per ripresa, pause e flussi espliciti |
| **Microsoft Agent Framework** | Agent, session, workflow, executor | Framework e integrazioni di hosting | Riferimento per orchestrazioni tipizzate e workflow durevoli |
| **OpenHands** | Agent, conversation, workspace, strumenti | Runtime/SDK per agenti software; applicazioni e automazione separate | Comparabile a un motore di esecuzione integrabile dietro una UI propria |
| **OpenClaw** | Gateway, agenti, sessioni, canali, automazioni | Assistente/gateway operativo, con più agenti e lavoro in background | Riferimento per canali, eventi, continuità e controllo delle azioni |

Questa classificazione è una lettura architetturale delle fonti, non una tassonomia dichiarata identicamente da tutti i vendor. Si basa sulle rispettive [definizioni di Paperclip](https://github.com/paperclipai/paperclip/blob/master/docs/start/what-is-paperclip.md), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [CrewAI](https://docs.crewai.com/core-concepts/Agents), [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview), [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/), [OpenHands SDK](https://docs.openhands.dev/sdk/arch/overview) e [OpenClaw](https://docs.openclaw.ai/concepts/multi-agent).

## 2. Paperclip: cosa coordina davvero

Il progetto qui considerato è **[paperclipai/paperclip](https://github.com/paperclipai/paperclip)**. Paperclip organizza agenti eseguiti da runtime diversi: definisce obiettivi e gerarchie, assegna issue, registra attività e applica politiche. Non è un nuovo modello linguistico. Il runtime che scrive codice o usa strumenti può essere Codex, Claude Code, un processo locale o un servizio HTTP. [Architettura a due livelli](https://github.com/paperclipai/paperclip/blob/master/docs/start/what-is-paperclip.md).

Il ciclo operativo documentato è:

1. Esiste un'organizzazione con un obiettivo e agenti con responsabilità.
2. Un incarico mantiene identità, stato, assegnatario e relazioni con altro lavoro.
3. Una scadenza, un'assegnazione, una menzione o un intervento umano provoca un heartbeat.
4. Il runtime dell'agente riprende il contesto, controlla gli incarichi e reclama il lavoro.
5. L'agente produce un risultato o segnala un blocco, lasciando aggiornamenti.
6. Il lavoro può passare a un altro agente o attendere un intervento umano.

Il checkout dell'issue evita che due agenti ne assumano contemporaneamente la responsabilità. Non equivale, da solo, a isolare qualsiasi file o servizio esterno condiviso. La seconda frase è un'inferenza sul confine della funzione. [Concetti](https://docs.paperclip.ing/guides/welcome/key-concepts/), [protocollo heartbeat](https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md).

### Budget, approvazioni e tracce sono oggetti diversi

- **Budget:** la documentazione distingue limiti mensili per organizzazione/agente e limiti complessivi di progetto; descrive avvisi e arresto dei successivi heartbeat quando la soglia è raggiunta. I costi dipendono dai dati comunicati dagli adattatori. Non assumere che una soglia applicativa garantisca matematicamente assenza di sforamenti della singola chiamata già in corso, o che una quota in abbonamento sia uguale a un costo API. Questo limite della verifica è rilevante anche quando la pagina usa formule promozionali assolute. [Costs](https://docs.paperclip.ing/guides/day-to-day/costs/).
- **Governance:** esistono richieste di assunzione, strategia e superamento budget con approve/reject/revision. Le guide e alcuni riferimenti API differiscono nel presentare l'approvazione delle assunzioni come obbligatoria o dipendente dalla policy: controllare configurazione e versione, senza dedurre che ogni azione abbia sempre un gate. [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/), [API reference](https://github.com/paperclipai/paperclip/blob/master/skills-releases/paperclip/v0/references/api-reference.md).
- **Revisione del risultato:** una execution policy può intercettare la chiusura di un'issue e indirizzarla a revisore e approvatore. Gli stadi sono configurabili. Questo controllo sul completamento dell'incarico è distinto dall'autorizzazione tecnica a eseguire un comando o pubblicare un contenuto. [Execution policy](https://docs.paperclip.ing/guides/power/execution-policy/).
- **Audit:** l'Activity Log conserva mutazioni con attore e timestamp; i transcript delle esecuzioni costituiscono un livello ulteriore. “Ho visto il messaggio finale” e “posso ricostruire chi ha autorizzato cosa” sono capacità differenti. [Activity Log](https://docs.paperclip.ing/guides/day-to-day/activity-log/).

Le **routines** producono esecuzioni tracciate mediante schedule cron, webhook o invocazione API/manuale. La schedulazione include un fuso orario; ogni esecuzione è riconducibile all'issue prodotta. L'heartbeat è la finestra di lavoro dell'agente, la routine è la definizione ricorrente del lavoro da avviare. [Heartbeats & Routines](https://docs.paperclip.ing/guides/projects-workflow/routines/).

### Paperclip e Codex possono comporsi

L'adattatore `codex_local` è documentato come esecuzione del Codex locale con continuità di sessione, home gestita e istruzioni/skill di Paperclip. Quindi il confronto corretto include **Paperclip sopra Codex**, non soltanto la scelta esclusiva fra i due. Configurazione del runner, directory, policy del runtime e disponibilità del provider restano componenti concrete dell'integrazione. Non si deve dedurre dal solo nome “adattatore Codex” che tutte le funzioni della desktop app siano esposte. [Adattatore ufficiale Paperclip](https://docs.paperclip.ing/reference/adapters/codex/).

## 3. Codex: partire dalle capacità attuali

Codex documenta già **subagenti con contesti separati**, delega parallela, raccolta risultati e possibilità di guidare o fermare gli agenti. CLI e app offrono superfici per ispezionarli; comportamento e comandi dipendono dalla release. Descriverlo come semplice chat a singolo agente falserebbe il confronto. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Le funzioni di **worktree** permettono di isolare checkout per attività parallele. Le **scheduled tasks** possono proseguire un contesto esistente o creare esecuzioni indipendenti e usare skill/plugin. Le attività locali legate a progetti richiedono che macchina, app e directory siano disponibili; non implicano automaticamente un servizio sempre acceso nel cloud. [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app).

Per una UI propria, l'**app-server** espone thread, autenticazione, approvazioni ed eventi: è un punto di integrazione diverso dal leggere solo l'output testuale di un comando. La documentazione consultata distingue trasporti e segnala limitazioni sperimentali per WebSocket: occorre verificare il contratto della versione scelta. [App-server](https://learn.chatgpt.com/docs/app-server).

Per il confronto futuro va separato anche il **prodotto Codex** dalle **API OpenAI**. Le fonti correnti descrivono Agents API con harness Codex gestito, sessioni durevoli, strumenti e subagenti; il servizio applicativo rimane da progettare. Non trasferire automaticamente requisiti di autenticazione, disponibilità o fatturazione dell'app alle API. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [scelta del runtime](https://developers.openai.com/api/docs/guides/agents).

L'organigramma aziendale persistente e il budget mensile per “dipendente” non risultano attestati come oggetti nativi di Codex nelle pagine lette. Questo non nega che un'applicazione esterna possa costruirli, o che nuove versioni abbiano ulteriori funzioni.

## 4. Framework: cosa offrono e cosa resta all'applicazione

### CrewAI

Le **Crews** combinano ruoli, strumenti e incarichi; i **Flows** organizzano stato, eventi, condizioni e diramazioni. `@persist` salva lo stato, con SQLite come backend predefinito e implementazioni sostituibili. È un meccanismo da incorporare nel proprio processo applicativo. [Crews/Flows](https://docs.crewai.com/core-concepts/Agents), [persistenza dei Flow](https://docs.crewai.com/en/concepts/flows).

Sono documentati modelli/provider diversi, integrazione di strumenti e MCP, human input e pause con feedback. **AMP** aggiunge deploy, API e tracce: va distinto dal pacchetto Python. Un “manager” di una crew coordina un'esecuzione; non va automaticamente equiparato al registro aziendale durevole di Paperclip. [LLM](https://docs.crewai.com/en/concepts/llms), [HITL](https://docs.crewai.com/en/learn/human-in-the-loop), [AMP](https://docs.crewai.com/enterprise/introduction).

### LangGraph e LangSmith

LangGraph permette di mescolare nodi di codice e decisioni LLM, con stato persistente e interruzioni. Un checkpointer in memoria non sopravvive al riavvio: la durabilità dipende anche dal backend scelto. `interrupt()` consente di fermare il flusso in attesa di input e poi riprenderlo. [Overview](https://docs.langchain.com/oss/python/langgraph/overview), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

LangSmith aggiunge osservabilità, valutazioni e deploy; il suo Agent Server gestisce thread/run e supporta cron, anche su un thread esistente oppure su thread nuovi. Queste capacità di piattaforma non vanno attribuite indistintamente alla sola libreria LangGraph. Le schedulazioni della guida consultata sono UTC. [Deployment cron](https://docs.langchain.com/langsmith/cron-jobs), [data plane](https://docs.langchain.com/langsmith/data-plane).

### Microsoft Agent Framework / AutoGen

La fonte Microsoft presenta Agent Framework come successore diretto di AutoGen e Semantic Kernel. Il repository **AutoGen è in maintenance mode**: le comparazioni basate solo sui vecchi esempi di group chat non rappresentano l'intera offerta corrente. [Overview](https://learn.microsoft.com/en-us/agent-framework/overview/), [stato di AutoGen](https://github.com/microsoft/autogen).

Agent Framework combina modelli/provider, strumenti/MCP, sessioni, middleware e workflow. Le interazioni umane sono esplicite richieste/risposte; il checkpoint conserva anche le richieste pendenti. L'estensione Durable Task aggiunge ripresa distribuita, timer ed eventi, separatamente dal semplice checkpoint di un workflow locale. Scheduling, infrastruttura e UI di controllo vanno valutati insieme al componente di hosting scelto. [HITL](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop), [Durable Extension](https://learn.microsoft.com/en-us/agent-framework/hosting/azure-functions).

## 5. Runtime e gateway

### OpenHands

Il Software Agent SDK distingue comportamento dell'agente, conversazione, strumenti e workspace; Agent Server rende l'esecuzione accessibile a client remoti. Sono possibili workspace locali o isolati. Modelli/provider, skill e MCP sono integrabili. [Architettura](https://docs.openhands.dev/sdk/arch/overview).

La persistenza conserva stato ed eventi della conversazione. `TaskToolSet` delega a subagenti riprendibili tramite ID: il pattern specifico documentato è **sincrono e bloccante**, non prova che ogni delega sia parallela. Le policy di conferma delle azioni sono distinte dall'analizzatore del rischio. [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence), [TaskToolSet](https://docs.openhands.dev/sdk/guides/task-tool-set), [Security](https://docs.openhands.dev/sdk/guides/security).

Il repository corrente separa il servizio **OpenHands/automation**, responsabile di cron, webhook, cronologia e dispatch, dal SDK che esegue le conversazioni. È quindi scorretto trattare la libreria da sola come tutta la piattaforma. [Confini SDK](https://github.com/OpenHands/software-agent-sdk), [Automation](https://github.com/OpenHands/automation).

### OpenClaw

Il Gateway instrada messaggi verso agenti distinti per workspace, identità, configurazione e sessioni. Le binding collegano canali/account agli agenti; non sono da sole una gerarchia di responsabili. La documentazione comprende inoltre subagenti, lavoro in background e flussi durevoli. [Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent), [Automation](https://docs.openclaw.ai/automation).

Sono documentati molti provider, plugin, canali e strumenti; le automazioni persistono e possono essere avviate a orario o attraverso eventi. Le approvazioni di esecuzione possono essere rivolte all'operatore e conservare autorizzazioni circoscritte. Un'autorità sul comando e un'approvazione manageriale di un deliverable sono funzioni diverse. [Features](https://docs.openclaw.ai/concepts/features), [automazioni correnti](https://docs.openclaw.ai/releases/2026.8.1/automations-and-scheduling), [exec approvals](https://docs.openclaw.ai/tools/exec-approvals).

## 6. Matrice delle capacità verificate

**Nativo** significa descritto come funzione del componente indicato, non automaticamente attivo. **Da costruire/verificare** significa che le fonti lette non stabiliscono un equivalente pronto con la stessa semantica; non significa “impossibile”. Le fonti di ciascuna riga sono sviluppate nelle sezioni precedenti.

| Sistema | Persistenza del lavoro | Organigramma | Budget organizzativo | Approvazione / intervento umano |
|---|---|---|---|---|
| Paperclip | Issue, assegnazioni, run e contesto dei runner | Nativo | Policy per organizzazione/agente/progetto | Governance, review gate, commenti, riassegnazione, pausa |
| Codex | Thread, sessioni, artifact e workspace | Ruoli/subagenti; organigramma aziendale non attestato | Equivalente per dipendente non attestato | Approvazioni di esecuzione e steering della chat/agenti |
| CrewAI | Stato Flow persistito; configurare backend e lifecycle | Ruoli e manager nel workflow | Da costruire/verificare nel livello piattaforma | Human input/feedback; funzioni AMP distinte |
| LangGraph / LangSmith | Checkpoint, thread e store; backend esplicito | Grafo/supervisore definito dall'app | Da costruire/verificare | Interrupt, modifica/input e ripresa; UI da integrare |
| Microsoft Agent Framework | Sessioni/checkpoint; Durable Extension per hosting durevole | Pattern definiti in codice | Da costruire/verificare | Richieste/risposte, tool approval e ripresa |
| OpenHands | Conversazioni, eventi e subtask riprendibili | Relazione padre/subagente; company registry non attestato | Metriche native; equivalenza mensile aziendale non attestata | Confirmation policy, messaggi e lifecycle conversazione |
| OpenClaw | Sessioni per agente, task e automazioni | Routing/identità; company hierarchy non attestata | Equivalente di budget aziendale non verificato | Approvals operativi e controllo di task/automazioni |

| Sistema | Modelli e strumenti | Avvio per orario/evento | Ispezione e audit |
|---|---|---|---|
| Paperclip | Runner eterogenei tramite adattatori; skill/integrations dipendono dal runner | Heartbeat, cron, webhook, API, assegnazioni/menzioni | Activity Log, issue, decisioni, transcript, costi |
| Codex | Modelli/ruoli configurabili; tool, MCP, skill e plugin secondo superficie | Scheduled tasks documentate; integrazione eventi da valutare per superficie | Cronologia, eventi, risultati, diff e controllo dei subagenti |
| CrewAI | LLM/provider e strumenti configurabili, MCP | Eventi Flow; cron/trigger esterni dipendono dall'host o piattaforma | Callback/eventi; tracing e monitoraggio AMP |
| LangGraph / LangSmith | Nodi e strumenti scelti dallo sviluppatore | Run/API e cron di LangSmith Deployment | Checkpoint e tracing/evaluation LangSmith |
| Microsoft Agent Framework | Più provider, tool/MCP e middleware | Timer/eventi attraverso hosting/Durable Task | Eventi, middleware/telemetria; UI e retention da configurare |
| OpenHands | Provider, tool, skill/MCP, workspace | Servizio Automation: cron/webhook/dispatch | Event log persistito, metriche e run history dell'automazione |
| OpenClaw | Più provider, canali e plugin; tool policy per agente | Automazioni, heartbeat e hook | Sessioni, task ledger, run history e approvazioni |

Non confondere **token/cost tracking** con **hard stop di spesa**, **trace di debug** con **audit immodificabile**, **persistenza della chat** con **garanzia di ripresa di ogni effetto esterno**, oppure **MCP disponibile** con **credenziali e autorizzazioni già collegate**. Sono distinzioni tecniche da mantenere nelle domande successive.

## 7. Implicazioni per Fuori Studio, senza decisioni di implementazione

Queste sono inferenze progettuali ricavate dal confronto:

1. **Il possibile valore di Fuori Studio non dipende dall'inventare la delega multi-agente.** Codex e altri runtime la offrono già. Il prodotto può distinguersi nel dare continuità al lavoro personale: obiettivi, prossime azioni, artefatti, interventi richiesti e contesto fra progetti.
2. **Il diorama deve rappresentare stati verificabili.** “Sta lavorando” può collegarsi a un run, “aspetta” a un'approvazione, “bloccato” a una dipendenza. L'animazione da sola non dimostra collaborazione fra processi autonomi.
3. **Un ruolo persistente e un worker non sono la stessa entità.** Un collega del team può conservare responsabilità mentre il motore sottostante cambia modello, apre una nuova sessione o delega lavoro temporaneo.
4. **Prima di scegliere un framework, definire il confine.** Per una conversazione che aiuta Riccardo a ragionare bastano funzioni diverse rispetto a una squadra che esegue lavori per giorni, riceve eventi, produce modifiche e attende review.
5. **Composizione e costruzione propria sono entrambe possibilità.** Fuori Studio potrebbe usare direttamente un runtime oppure una piattaforma organizzativa come Paperclip. Valutarle richiede un incarico concreto end-to-end; questa ricerca non autorizza né decide una migrazione.

Domande utili per il prossimo confronto: quale lavoro deve continuare senza la chat aperta; quali artefatti devono produrre gli agenti; chi può pubblicare o modificare sistemi esterni; come si conserva il contesto; come si riconosce un blocco; dove vive il limite di spesa; come si interrompe e riprende lo stesso incarico.
