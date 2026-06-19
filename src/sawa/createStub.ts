/**
 * The ONLY write-shaped command — and it performs zero I/O. It echoes what *would*
 * be created. Real writes land in a later (order-engine) phase that reuses the Sawa
 * app's own logic; the bot never writes the live DB directly.
 */

export interface StubResult {
  created: false;
  stub: true;
  message: string;
  wouldCreate: { question: string; outcomes: string[] };
}

export function stubCreate(question: string, outcomes: string[] = ["Yes", "No"]): StubResult {
  return {
    created: false,
    stub: true,
    message:
      `Preview only — nothing was created. Creating real markets lands in a later phase.\n` +
      `Would create: "${question}" with [${outcomes.join(", ")}].`,
    wouldCreate: { question, outcomes },
  };
}
