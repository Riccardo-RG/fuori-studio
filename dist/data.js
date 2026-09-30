import { t } from './i18n.js';
import {defaultAgentProfiles, findAgentProfile, PROFILE_CATALOG_VERSION} from './agent-profiles.js';
export const projects = [
 {id:'portfolio',get name(){return t('Tutti i tuoi progetti');},get category(){return t('Tutti gli 8 progetti');},get description(){return t('Scegliere il prossimo esperimento tra prodotti personali, progetti per clienti e lavoro.');},get experiment(){return t('Per ogni progetto, scrivi il prossimo risultato verificabile, un impegno di tempo e gli eventuali vincoli già concordati. Scegli un solo esperimento da portare fino alla verifica.');},get question(){return t('Quale progetto ha oggi un problema preciso, una persona con cui verificarlo e un prossimo passo compatibile con i tuoi impegni?');},get deliverable(){return t('Una decisione motivata sul prossimo esperimento, con le informazioni ancora mancanti.');}},
 {id:'builder',get name(){return t('Generatore di gestionali');},get category(){return t('AI · SOFTWARE B2B');},get description(){return t('Software che crea gestionali a partire dalle esigenze di chi lo usa.');},get experiment(){return t('Genera da un brief una piccola app con clienti, attività e stati. Fai completare un flusso a un potenziale utilizzatore.');},get question(){return t('Riesce a svolgere l’attività e a chiedere una modifica senza il tuo aiuto tecnico?');},get deliverable(){return t('Un flusso dimostrabile e gli ostacoli osservati durante la prova.');}},
 {id:'avatar',get name(){return t('Avatar & Content Studio');},get category(){return t('AI · CONTENUTI');},get description(){return t('Uno studio per organizzare contenuti di avatar e strategie di presenza online.');},get experiment(){return t('Prepara tre brevi contenuti con lo stesso avatar e tre tagli narrativi. Raccogli un confronto qualitativo da persone del pubblico che vuoi raggiungere.');},get question(){return t('Quale contenuto invoglia a seguire il progetto? L’avatar aumenta o riduce la fiducia?');},get deliverable(){return t('Una direzione editoriale da testare e una prima serie di contenuti.');}},
 {id:'necklace',get name(){return t('Collane gemelle');},get category(){return t('HARDWARE · CONNESSIONE');},get description(){return t('Una collana smart che invia un impulso alla sua gemella.');},get experiment(){return t('Simula tra due telefoni l’invio volontario di un segnale aptico, prima di ampliare il prototipo hardware.');},get question(){return t('In quale momento le persone sceglierebbero questo gesto al posto di un messaggio?');},get deliverable(){return t('Un caso d’uso osservato e i requisiti minimi per il prototipo hardware.');}},
 {id:'horeca',get name(){return t('HORECA OS');},get category(){return t('SOFTWARE · OSPITALITÀ');},get description(){return t('Gestionale per servizi HORECA, menu online e prenotazioni.');},get experiment(){return t('Prototipa il percorso menu → prenotazione → gestione del tavolo e osservalo insieme a un operatore.');},get question(){return t('Quale passaggio elimina un problema concreto durante il servizio?');},get deliverable(){return t('Un flusso essenziale validato con chi gestisce il locale.');}},
 {id:'group',get name(){return t('Group Agent');},get category(){return t('AI · COLLABORAZIONE');},get description(){return t('Una chat di gruppo con un agente che aiuta a realizzare progetti e obiettivi condivisi.');},get experiment(){return t('Simula una conversazione di progetto: l’agente propone obiettivo, responsabili e prossime azioni, chiedendo conferma al gruppo.');},get question(){return t('L’agente chiarisce il lavoro o interrompe la conversazione?');},get deliverable(){return t('Una conversazione dimostrativa e le regole per intervenire al momento giusto.');}},
 {id:'roblox',get name(){return t('Roblox Game');},get category(){return t('GAMING · ROBLOX');},get description(){return t('Un gioco Roblox in sviluppo.');},get experiment(){return t('Prepara una breve esperienza giocabile centrata su una sola meccanica. Osserva le prime sessioni senza spiegare in anticipo ogni passaggio.');},get question(){return t('Il giocatore capisce cosa fare e sceglie spontaneamente di riprovare?');},get deliverable(){return t('Una meccanica giocabile e una lista degli attriti osservati.');}},
 {id:'tourism',get name(){return t('Tourism Apps');},get category(){return t('MOBILE · LAVORO');},get description(){return t('App per il turismo assegnate dal tuo datore di lavoro.');},get experiment(){return t('Concorda con il referente un flusso rappresentativo e provalo con dati dimostrativi, per esempio scoperta → luogo → itinerario.');},get question(){return t('Il flusso soddisfa il bisogno concordato e i criteri di accettazione del referente?');},get deliverable(){return t('Un flusso verificabile con criteri di accettazione condivisi.');}},
 {id:'trainer',get name(){return t('Personal Trainer Hub');},get category(){return t('WEB · PROGETTO CLIENTE');},get description(){return t('Presenza online per un personal trainer: landing page e gestionale.');},get experiment(){return t('Collega una landing dimostrativa a una richiesta di informazioni e alla gestione del primo appuntamento. Prova il percorso con il trainer.');},get question(){return t('Il trainer riceve le informazioni necessarie per ricontattare e seguire un nuovo contatto?');},get deliverable(){return t('Un percorso completo dal primo interesse alla gestione del contatto.');}}
];
export const agents = [
 {id:'nova',name:'Riccardo',get role(){return t('Il leader');},color:'#bc684b',x:49,y:67,crop:[0,397],get quote(){return t('Una cosa per volta. Ma quella giusta.');},get description(){return t('Guida il team, trasforma i tuoi obiettivi in incarichi chiari e riunisce i risultati. Tiene insieme i tanti progetti senza confondere priorità, ipotesi e scadenze.');},get skills(){return [t('Definire obiettivo e risultato atteso'),t('Dividere il lavoro tra gli specialisti'),t('Portarti la prossima decisione, con i dubbi ancora aperti')];},get task(){return t('Guida il team verso il prossimo passo.');}},
 {id:'radar',name:'Raffaele',get role(){return t('Trend & ricerca');},color:'#487557',x:48,y:40,crop:[397,830],get quote(){return t('Interessante. Ma dov’è la fonte?');},get description(){return t('Cerca problemi reali, alternative e segnali di mercato. Nella versione collegata dovrà mostrare fonti, date e limiti di ogni ricerca.');},get skills(){return [t('Raccogliere fonti e segnali pertinenti'),t('Esaminare alternative e concorrenti'),t('Separare evidenze, ipotesi e domande aperte')];},get task(){return t('Cerca segnali, non solo hype.');}},
 {id:'forge',name:'Big Fonz',get role(){return t('Prodotto & sviluppo');},color:'#80629b',x:76,y:51,crop:[830,1278],get quote(){return t('E se bastasse una sola feature?');},get description(){return t('Ti aiuta a trasformare la tua competenza full stack, mobile e AI in un esperimento piccolo e verificabile.');},get skills(){return [t('Ridurre l’idea al flusso essenziale'),t('Definire vincoli e criteri di accettazione'),t('Preparare un piano tecnico per il prototipo')];},get task(){return t('Porta il prossimo MVP alla prova.');}},
 {id:'muse',name:"D'albenzio",get role(){return t('Contenuti & idee');},color:'#96701e',x:24,y:46,crop:[1278,1713],get quote(){return t('Questa merita di essere raccontata.');},get description(){return t('Trasforma ciò che costruisci in messaggi comprensibili, demo e contenuti. Collega il racconto al pubblico di ogni progetto.');},get skills(){return [t('Trovare un messaggio e un taglio narrativo'),t('Progettare contenuti e dimostrazioni'),t('Rendere riconoscibile la tua presenza online')];},get task(){return t('Dà una voce a quello che crei.');}},
 {id:'growth',name:'Cicciolina',get role(){return t('Business & ricavi');},color:'#457b94',x:80,y:70,crop:[1713,2172],get quote(){return t('Bella idea. Chi la vorrebbe davvero?');},get description(){return t('Formula ipotesi su pubblico, distribuzione e disponibilità a pagare. Collega ogni ipotesi a un esperimento, senza promettere ricavi.');},get skills(){return [t('Definire un pubblico e un problema specifico'),t('Proporre un esperimento commerciale'),t('Stabilire quale segnale aiuterebbe a decidere')];},get task(){return t('Cerca un modello da verificare.');}}
];

/** Apply validated display names without changing stable agent IDs or assignments. */
export function applyAgentNames(names) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return;
  for (const agent of agents) {
    const value = Object.hasOwn(names, agent.id) ? names[agent.id] : undefined;
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    agent.name = name;
  }
}

let specialtyVersion=1, specialties={...defaultAgentProfiles};
export function applyAgentProfiles(snapshot) {
  if(!Number.isSafeInteger(snapshot?.version)||snapshot.version<1||!snapshot.profiles||Object.keys(snapshot.profiles).length!==agents.length||agents.some(agent=>!Object.hasOwn(snapshot.profiles,agent.id)||!findAgentProfile(snapshot.profiles[agent.id])))throw Error('Lo studio ha restituito specializzazioni non valide.');
  specialties={...snapshot.profiles};specialtyVersion=snapshot.version;
}
export function agentCapability(id) {
  if(!Object.hasOwn(specialties,id))throw Error('Specializzazione o versione non valida.');
  const profile=findAgentProfile(specialties[id]);
  return {version:specialtyVersion,catalogVersion:PROFILE_CATALOG_VERSION,profileId:profile.id};
}
for(const agent of agents) {
  const profile=()=>findAgentProfile(specialties[agent.id]);
  Object.defineProperties(agent,{
    role:{get:()=>t(profile().title)},description:{get:()=>t(profile().description)},
    skills:{get:()=>profile().skills.map(value=>t(value))},task:{get:()=>t(profile().deliverable)},
  });
}
