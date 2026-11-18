// The merge conflicts window: one line per field that several mods set differently, one column
// per mod. A mod's value is the button that picks it; a mod's name picks it for every line.
import * as React from 'react';

import type { Choices } from '../choices';
import { conflictGroups, conflictLines, pickAll, type ConflictsState, type ConflictsStore } from './conflicts-store';

interface Props {
  store: ConflictsStore;
  /** saves the choices and redeploys */
  onApply: (choices: Choices) => void;
  /** downloads Mafia Toolkit, whose list names more columns */
  onInstallToolkit: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vortexApi = () => require('vortex-api');

const td: React.CSSProperties = { padding: '2px 10px', verticalAlign: 'middle', whiteSpace: 'nowrap' };
const muted: React.CSSProperties = { opacity: 0.55 };
const chip = (on: boolean): React.CSSProperties => ({
  background: on ? 'rgba(255,255,255,0.14)' : 'transparent',
  border: `1px solid ${on ? 'currentColor' : 'transparent'}`,
  borderRadius: 3,
  color: 'inherit',
  padding: '0 8px',
  fontWeight: on ? 600 : 400,
  opacity: on ? 1 : 0.6,
  cursor: 'pointer',
});
const headButton: React.CSSProperties = { ...chip(false), opacity: 1, fontWeight: 600, padding: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' };

export function ConflictsDialog({ store, onApply, onInstallToolkit }: Props) {
  const [state, setState] = React.useState<ConflictsState>(store.get());
  const [pending, setPending] = React.useState<Choices>(store.get().choices);
  React.useEffect(() => store.subscribe(s => {
    setState(s);
    setPending(s.choices);
  }), [store]);

  const { Modal } = vortexApi();
  const groups = conflictGroups(state.reports);
  const name = (mod: string) => state.names[mod] ?? mod;
  const close = () => store.set({ open: false });

  return (
    <Modal show={state.open} onHide={close} bsSize='large'>
      <Modal.Header>
        <Modal.Title>Merge conflicts</Modal.Title>
      </Modal.Header>
      <Modal.Body style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <p style={muted}>
          Mods set these values differently. Click the one the game should get.
          {!state.hasToolkit && groups.some(g => conflictLines(pending, g.file, g.conflicts, state.columnNames).some(l => l.field.startsWith('#'))) && (
            <>
              {' '}Columns shown as #number have no known name;{' '}
              <a href='#' onClick={e => { e.preventDefault(); onInstallToolkit(); }}>install Mafia Toolkit</a>
              {' '}for its list of names.
            </>
          )}
        </p>
        {groups.length === 0 && <p>No conflicts in the last deploy.</p>}
        {groups.map(g => (
          <table key={g.file} style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={td} title={g.file}>{g.file.split('/').pop()}</th>
                <th style={{ ...td, ...muted }}>value</th>
                <th style={{ ...td, ...muted }}>vanilla</th>
                {g.mods.map(m => (
                  <th key={m} style={td}>
                    <button type='button' style={headButton} title={`${m}\nClick: take all from this mod`}
                      onClick={() => setPending(p => pickAll(p, g.file, g.conflicts, m))}>
                      {name(m)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conflictLines(pending, g.file, g.conflicts, state.columnNames).map(line => (
                <tr key={line.key} title={line.title}
                  style={line.place !== '' ? { borderTop: '1px solid rgba(128,128,128,0.25)' } : undefined}>
                  <td style={td}>
                    {line.place}
                    {line.table !== '' && <div style={{ ...muted, fontSize: '0.85em' }}>{line.table}</div>}
                  </td>
                  <td style={td}>
                    {line.field}
                    {line.hint !== '' && <div style={{ ...muted, fontSize: '0.85em' }}>{line.hint}</div>}
                  </td>
                  <td style={{ ...td, ...muted }}>{line.vanilla}</td>
                  {g.mods.map(m => (
                    <td key={m} style={td}>
                      {line.values[m] === undefined
                        ? <span style={muted}>·</span>
                        : <button type='button' style={chip(line.chosen === m)}
                            onClick={() => setPending(p => line.pick(p, m))}>
                            {line.values[m]}
                          </button>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </Modal.Body>
      <Modal.Footer>
        <button type='button' className='btn btn-link' style={{ float: 'left' }}
          onClick={() => setPending(p => Object.fromEntries(Object.keys(p).map(f => [f, {}])))}>
          Reset to mod order
        </button>
        <button type='button' className='btn btn-default' onClick={close}>Cancel</button>
        <button type='button' className='btn btn-primary' disabled={groups.length === 0}
          onClick={() => { close(); onApply(pending); }}>
          Apply and deploy
        </button>
      </Modal.Footer>
    </Modal>
  );
}
