import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { offFiles, offText, withOffFiles } from './file-choice';

const root = path.join('E:', 'Games', 'Mafia II');

describe('file choice', () => {
  it('reads turned-off files from the overrides, inside the mod', () => {
    const overrides = [path.join(root, 'pc', 'sds', 'City_Univers', 'city_univers.sds'), path.join('D:', 'elsewhere.sds')];
    expect(offFiles(overrides, root)).toEqual(new Set(['pc/sds/city_univers/city_univers.sds']));
    expect(offFiles(undefined, root)).toEqual(new Set());
  });

  it('replaces the .sds overrides and keeps the others', () => {
    const other = path.join(root, 'pc', 'edit', 'config.xml');
    const old = path.join(root, 'pc', 'sds', 'tables', 'tables.sds');
    const next = withOffFiles([other, old], root, ['pc/sds/city_univers/city_univers.sds']);
    expect(next).toEqual([other, path.join(root, 'pc', 'sds', 'city_univers', 'city_univers.sds')]);
    expect(offFiles(next, root)).toEqual(new Set(['pc/sds/city_univers/city_univers.sds']));
    expect(withOffFiles([old], root, [])).toEqual([]);
  });

  it('says how many are off', () => {
    expect(offText(0)).toBe('');
    expect(offText(1)).toBe('1 file off');
    expect(offText(3)).toBe('3 files off');
  });
});
