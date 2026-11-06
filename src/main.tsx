import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/pdf-textlayer.css';
import './app/styles.css';

// Kontextmenü des WebViews im Release ausblenden; Textfelder behalten ihr Menü.
if (import.meta.env.PROD) {
  window.addEventListener('contextmenu', (e) => {
    if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
