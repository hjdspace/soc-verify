import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/globals.css';
import './styles/ai-panel.css';

// ── Anti-flash: apply persisted theme before first render ───────────
// Reading localStorage and setting data-theme here (in the entry module)
// ensures the correct CSS variables are active before React paints,
// preventing a flash of the default dark theme on startup.
{
  const THEME_KEY = 'socverify:theme';
  const LIGHT_THEMES = new Set(['drafting', 'daylight', 'apple-light']);
  const saved = localStorage.getItem(THEME_KEY);
  const root = document.documentElement;
  if (saved) {
    root.dataset.theme = saved;
    const shade = LIGHT_THEMES.has(saved) ? 'light' : 'dark';
    root.dataset.shade = shade;
    root.style.colorScheme = shade;
  } else {
    // Default theme: bench (dark)
    root.dataset.theme = 'bench';
    root.dataset.shade = 'dark';
    root.style.colorScheme = 'dark';
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
