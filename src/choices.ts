// The user's choices for merge conflicts (made in the conflicts window, ui/ConflictsDialog).
//
// Stored per game in the staging folder (`mafia2-merge-choices.json`):
//   { "<file inside the game folder>": { "<row, field or resource id>": "<mod folder name>" } }
// A choice is used on every deploy while the chosen mod still changes that place; otherwise the
// mod lower in the mod list wins, as without a choice.
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type Choices = Record<string, Record<string, string>>;

export const CHOICES_FILE = 'mafia2-merge-choices.json';

export function loadChoices(stagingPath: string): Choices {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stagingPath, CHOICES_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Choices : {};
  } catch {
    return {};
  }
}

export async function saveChoices(stagingPath: string, choices: Choices): Promise<void> {
  await fs.writeFile(path.join(stagingPath, CHOICES_FILE), `${JSON.stringify(choices, null, 2)}\n`);
}

export const picksFor = (choices: Choices, file: string): ReadonlyMap<string, string> =>
  new Map(Object.entries(choices[file] ?? {}));
