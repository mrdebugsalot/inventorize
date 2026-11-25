import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import { createReplica, loadIdentity } from './session.ts';
import './styles.css';

registerSW({ immediate: true });

const root = createRoot(document.getElementById('root')!);

function start(): void {
  const replica = createReplica(loadIdentity());
  root.render(
    <StrictMode>
      <App replica={replica} />
    </StrictMode>,
  );
}

// One active tab per device: two tabs would share a device id and number their changes
// independently, which sync would treat as duplicates.
if (navigator.locks) {
  void navigator.locks.request('inventorize-active-tab', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      root.render(
        <p className="empty">
          Inventorize is already open in another tab or window. Close it there, then reload this page.
        </p>,
      );
      return;
    }
    start();
    await new Promise(() => {}); // hold the lock while this tab is open
  });
} else {
  start();
}
