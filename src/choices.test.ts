import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadChoices, picksFor, saveChoices } from './choices';

const TABLES = 'pc/sds/tables/tables.sds';

describe('choices file', () => {
  it('round-trips and reads missing as empty', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mafia2-choices-'));
    try {
      expect(loadChoices(dir)).toEqual({});
      await saveChoices(dir, { [TABLES]: { x: 'A' } });
      expect(picksFor(loadChoices(dir), TABLES)).toEqual(new Map([['x', 'A']]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
