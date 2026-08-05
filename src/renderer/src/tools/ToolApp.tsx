/**
 * ToolApp — entry point for tool windows.
 *
 * When the renderer loads with a `#tool=<id>` hash, this component
 * renders the corresponding tool inside a ToolWindow layout.
 * When there's no hash, the normal AppShell is rendered (main window).
 */

import { useState, useEffect } from 'react';
import { ToolWindow } from './ToolWindow';
import { getToolComponent } from './registry';
import { ToolPlaceholder } from './ToolPlaceholder';
import { ALL_TOOLS, type ToolMeta } from '@shared/tool-types';
import { useThemeStore } from '@renderer/stores/theme';
import { useFontStore } from '@renderer/stores/font';

/** Parse the tool ID from the URL hash (`#tool=<id>`). */
function getToolIdFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#tool=')) return null;
  return hash.slice('#tool='.length);
}

export function ToolApp() {
  const [toolId, setToolId] = useState<string | null>(() => getToolIdFromHash());
  const initTheme = useThemeStore((s) => s.initTheme);
  const initFont = useFontStore((s) => s.initFont);

  // Initialize theme for tool windows (same as main window)
  useEffect(() => {
    initTheme();
    initFont();
  }, [initTheme, initFont]);

  // Listen for hash changes (shouldn't happen in practice, but handle gracefully)
  useEffect(() => {
    const handler = () => setToolId(getToolIdFromHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (!toolId) {
    return null;
  }

  const tool = ALL_TOOLS.find((t: ToolMeta) => t.id === toolId);
  const ToolComponent = getToolComponent(toolId) ?? ToolPlaceholder;

  return (
    <ToolWindow toolId={toolId}>
      {(props) => <ToolComponent {...props} />}
    </ToolWindow>
  );
}
