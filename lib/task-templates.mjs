// Product templates are application instructions, never fabricated project facts.
export const productBriefSteps = () => [
  { title: 'Brief e criteri di riuscita', agentId: 'nova', instruction: 'Definisci obiettivo del prodotto proprietario, destinatari, vincoli e criteri di accettazione usando il brief. Elenca input mancanti e ipotesi senza inventarli.' },
  { title: 'Analisi dei materiali disponibili', agentId: 'radar', instruction: 'Analizza soltanto brief, contesto autorizzato e passaggio precedente. Distingui evidenze fornite, ipotesi e ricerche esterne ancora necessarie. Non simulare navigazione o fonti.' },
  { title: 'Proposta di prodotto', agentId: 'forge', instruction: 'Proponi una soluzione concreta, perimetro del primo rilascio, alternative, rischi e verifiche. Collega ogni scelta ai criteri del brief e al lavoro già svolto.' },
  { title: 'Consegna da revisionare', agentId: 'muse', instruction: 'Assembla una proposta completa e leggibile per il proprietario del prodotto: obiettivo, soluzione, piano dei prossimi passi, criteri di riuscita e decisioni aperte. Conserva limiti e incertezze. Non dichiarare approvazioni o attività esterne eseguite.' },
];
