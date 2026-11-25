import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  reduce,
  stockStatus,
  visibleItems,
  type Conflict,
  type ItemField,
  type ItemState,
  type OpBody,
} from '@inventorize/core';
import type { Replica } from '@inventorize/sync';
import { displayName, findByName, parseQuickLog, type QuickLog } from './quicklog.ts';
import { Endpoint, inviteLink, settings } from './session.ts';

const CLOUD_URL: string = import.meta.env.VITE_CLOUD_URL ?? '';
const UNDO_MS = 10_000;

interface Toast {
  text: string;
  opIds: string[];
}

/** Bumps whenever ops arrive (local or synced), so state is recomputed. */
function useOpsVersion(replica: Replica): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const off = replica.onOps(() => setVersion((v) => v + 1));
    return () => void off();
  }, [replica]);
  return version;
}

export function App({ replica }: { replica: Replica }) {
  const [, force] = useState(0);
  const endpoints = useMemo(() => {
    const rerender = () => force((v) => v + 1);
    return {
      cloud: new Endpoint('Cloud', replica, rerender),
      hub: new Endpoint('Home hub', replica, rerender),
    };
  }, [replica]);

  const [member, setMember] = useState(settings.member());
  const [hubUrl, setHubUrl] = useState(settings.hubUrl());
  const [showSettings, setShowSettings] = useState(!settings.member());
  const [toast, setToast] = useState<Toast | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const version = useOpsVersion(replica);

  useEffect(() => endpoints.cloud.setUrl(CLOUD_URL), [endpoints]);
  useEffect(() => endpoints.hub.setUrl(hubUrl), [endpoints, hubUrl]);
  useEffect(() => {
    const nudge = () => {
      endpoints.cloud.nudge();
      endpoints.hub.nudge();
    };
    addEventListener('online', nudge);
    document.addEventListener('visibilitychange', nudge);
    return () => {
      removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', nudge);
    };
  }, [endpoints]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const state = useMemo(() => reduce(replica.store.all()), [replica, version]);
  const items = visibleItems(state);
  const actor = member || 'Someone';

  const commit = (bodies: OpBody[], text: string) => {
    const ops = bodies.map((b) => replica.commit(actor, b));
    setToast({ text, opIds: ops.map((o) => o.id) });
  };

  const undo = () => {
    if (!toast) return;
    for (const id of [...toast.opIds].reverse()) replica.commit(actor, { type: 'op.undo', targetOpId: id });
    setToast(null);
  };

  const conflicts = state.conflicts.filter((c) => !dismissed.has(c.keptOpId)).slice(-3).reverse();

  return (
    <div className="app">
      <header className="bar">
        <h1>Inventorize</h1>
        <SyncPill cloud={endpoints.cloud} hub={endpoints.hub} />
        <button className="icon" aria-label="Settings" onClick={() => setShowSettings((s) => !s)}>
          ⚙
        </button>
      </header>

      {showSettings && (
        <Settings
          household={replica.household}
          member={member}
          hubUrl={hubUrl}
          onSave={(m, h) => {
            settings.setMember(m);
            settings.setHubUrl(h);
            setMember(m.trim());
            setHubUrl(h.trim());
            setShowSettings(false);
          }}
        />
      )}

      <QuickLogBox items={items} onCommit={commit} />

      {conflicts.map((c) => (
        <ConflictNotice
          key={c.keptOpId}
          conflict={c}
          item={state.items[c.itemId]}
          onKeep={() => setDismissed((d) => new Set(d).add(c.keptOpId))}
          onRevert={(item) => {
            commit(
              [{ type: 'item.update', itemId: item.id, field: c.field, value: c.overwritten as never, base: item.fieldHlc[c.field] ?? null }],
              `${item.name}: ${fieldLabel(c.field)} set back to ${String(c.overwritten)}`,
            );
            setDismissed((d) => new Set(d).add(c.keptOpId));
          }}
        />
      ))}

      {items.length === 0 ? (
        <p className="empty">
          Nothing tracked yet. Type something like <b>2 milk</b> or <b>6 eggs</b> above.
        </p>
      ) : (
        <ul className="items">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} onCommit={commit} />
          ))}
        </ul>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  );
}

function SyncPill({ cloud, hub }: { cloud: Endpoint; hub: Endpoint }) {
  let text = 'Offline · changes saved on this device';
  let tone = 'warn';
  if (hub.state === 'online') [text, tone] = ['Synced · Home hub', 'ok'];
  else if (cloud.state === 'online') [text, tone] = ['Synced · Cloud', 'ok'];
  else if (cloud.state === 'off' && hub.state === 'off') [text, tone] = ['This device only', 'muted'];
  else if (cloud.state === 'connecting' || hub.state === 'connecting') [text, tone] = ['Connecting…', 'muted'];
  return <span className={`pill ${tone}`}>{text}</span>;
}

function QuickLogBox({ items, onCommit }: { items: ItemState[]; onCommit: (b: OpBody[], text: string) => void }) {
  const [text, setText] = useState('');
  const parsed = parseQuickLog(text);
  const preview = parsed ? describe(parsed, items) : '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed) return;
    const existing = findByName(items, parsed.name);
    const bodies: OpBody[] = [];
    let itemId = existing?.id;
    if (!itemId) {
      itemId = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const qty = parsed.kind === 'set' ? parsed.qty : Math.max(parsed.delta, 0);
      bodies.push({
        type: 'item.create',
        itemId,
        fields: { name: displayName(parsed.name), unit: '', min: 1, par: Math.max(2, qty), locationId: null, categoryId: null },
      });
    }
    if (parsed.kind === 'set') bodies.push({ type: 'stock.set', itemId, qty: parsed.qty });
    else if (parsed.delta !== 0 && (existing || parsed.delta > 0)) {
      bodies.push({ type: 'stock.adjust', itemId, delta: parsed.delta, reason: parsed.delta > 0 ? 'bought' : 'used' });
    }
    onCommit(bodies, preview);
    setText('');
  };

  return (
    <form className="quick" onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Quick log: 2 milk · used eggs · out of rice"
        aria-label="Quick log"
        enterKeyHint="done"
        autoCapitalize="none"
      />
      <button type="submit" disabled={!parsed}>
        Log
      </button>
      {preview && <p className="preview">{preview}</p>}
    </form>
  );
}

function describe(p: QuickLog, items: ItemState[]): string {
  const existing = findByName(items, p.name);
  const name = existing?.name ?? displayName(p.name);
  if (!existing) {
    return p.kind === 'set' ? `New item: ${name} (out of stock)` : `New item: ${name}, ${Math.max(p.delta, 0)} in stock`;
  }
  if (p.kind === 'set') return p.qty === 0 ? `${name}: mark as out` : `${name}: set count to ${p.qty}`;
  return p.delta > 0 ? `${name}: +${p.delta}` : `${name}: ${p.delta} (used)`;
}

function ItemRow({ item, onCommit }: { item: ItemState; onCommit: (b: OpBody[], text: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = stockStatus(item);
  const toPar = Math.max(0, item.par - item.qty);
  const adjust = (delta: number) =>
    onCommit(
      [{ type: 'stock.adjust', itemId: item.id, delta, reason: delta > 0 ? 'bought' : 'used' }],
      `${item.name} ${delta > 0 ? '+' : ''}${delta}`,
    );

  return (
    <li className={`item ${status}`}>
      <div className="row">
        <button className="name" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="dot" aria-hidden />
          <span>{item.name}</span>
          <span className="status-text">{status === 'out' ? 'Out' : status === 'low' ? 'Low' : ''}</span>
        </button>
        <button className="step" aria-label={`Use one ${item.name}`} disabled={item.qty <= 0} onClick={() => adjust(-1)}>
          −
        </button>
        <span className="qty" aria-label="quantity">
          {item.qty}
          {item.unit && <small> {item.unit}</small>}
        </span>
        <button className="step" aria-label={`Add one ${item.name}`} onClick={() => adjust(1)}>
          +
        </button>
      </div>
      {open && (
        <div className="details">
          <NumberField label="Low at" value={item.min} onSet={(v) => onCommit([update(item, 'min', v)], `${item.name}: low at ${v}`)} />
          <NumberField label="Full at" value={item.par} onSet={(v) => onCommit([update(item, 'par', v)], `${item.name}: full at ${v}`)} />
          <button
            disabled={toPar === 0}
            onClick={() =>
              onCommit([{ type: 'stock.adjust', itemId: item.id, delta: toPar, reason: 'bought' }], `${item.name} restocked to ${item.par}`)
            }
          >
            Restock to {item.par}
          </button>
          <button className="subtle" onClick={() => onCommit([{ type: 'item.archive', itemId: item.id }], `${item.name} archived`)}>
            Archive
          </button>
        </div>
      )}
    </li>
  );
}

function update(item: ItemState, field: ItemField, value: number): OpBody {
  return { type: 'item.update', itemId: item.id, field, value, base: item.fieldHlc[field] ?? null };
}

function NumberField({ label, value, onSet }: { label: string; value: number; onSet: (v: number) => void }) {
  return (
    <label className="numfield">
      {label}
      <span>
        <button type="button" disabled={value <= 0} onClick={() => onSet(Math.max(0, value - 1))}>
          −
        </button>
        <b>{value}</b>
        <button type="button" onClick={() => onSet(value + 1)}>
          +
        </button>
      </span>
    </label>
  );
}

const fieldLabel = (f: ItemField): string =>
  ({ name: 'name', unit: 'unit', min: 'low-at level', par: 'full-at level', locationId: 'location', categoryId: 'category' })[f];

function ConflictNotice({
  conflict: c,
  item,
  onKeep,
  onRevert,
}: {
  conflict: Conflict;
  item: ItemState | undefined;
  onKeep: () => void;
  onRevert: (item: ItemState) => void;
}) {
  if (!item) return null;
  return (
    <div className="conflict" role="alert">
      <p>
        <b>{c.keptBy}</b> and <b>{c.overwrittenBy ?? 'someone'}</b> changed {item.name}’s {fieldLabel(c.field)} at the same
        time. Kept <b>{String(c.kept)}</b>, replaced <b>{String(c.overwritten)}</b>.
      </p>
      <div>
        <button onClick={onKeep}>Keep {String(c.kept)}</button>
        <button className="subtle" onClick={() => onRevert(item)}>
          Use {String(c.overwritten)}
        </button>
      </div>
    </div>
  );
}

function Settings({
  household,
  member,
  hubUrl,
  onSave,
}: {
  household: string;
  member: string;
  hubUrl: string;
  onSave: (member: string, hubUrl: string) => void;
}) {
  const [name, setName] = useState(member);
  const [hub, setHub] = useState(hubUrl);
  const [copied, setCopied] = useState(false);
  const link = inviteLink(household);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name, hub);
      }}
    >
      <label>
        Your name
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya" required />
      </label>
      <label>
        Home hub address <small>(optional, e.g. wss://yourhome-hub.duckdns.org:8443)</small>
        <input value={hub} onChange={(e) => setHub(e.target.value)} placeholder="Leave empty until the hub is set up" />
      </label>
      <div className="invite">
        <span>Invite family: share this link</span>
        <code>{link}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <small>Until sign-in arrives (phase 2), anyone with this link can see and edit your list.</small>
      </div>
      <button type="submit">Save</button>
    </form>
  );
}
