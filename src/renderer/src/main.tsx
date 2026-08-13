import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// ── Anti-flash: apply persisted theme before first render ───────────
// Reading localStorage and setting data-theme here (in the entry module)
// ensures the correct CSS variables are active before React paints,
// preventing a flash of the default dark theme on startup.
{
  const THEME_KEY = 'socverify:theme';
  const LIGHT_THEMES = new Set(['drafting', 'daylight']);
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    const root = document.documentElement;
    root.dataset.theme = saved;
    root.style.colorScheme = LIGHT_THEMES.has(saved) ? 'light' : 'dark';
  } else {
    // Default theme: bench (dark)
    const root = document.documentElement;
    root.dataset.theme = 'bench';
    root.style.colorScheme = 'dark';
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
