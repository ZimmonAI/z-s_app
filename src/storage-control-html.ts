export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function controlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Z-s storage control login and vault planner">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --surface-primary: Canvas; --surface-panel: color-mix(in srgb, CanvasText 4%, Canvas); --surface-subtle: color-mix(in srgb, CanvasText 8%, Canvas); --text-primary: CanvasText; --text-secondary: color-mix(in srgb, CanvasText 68%, Canvas); --border-default: color-mix(in srgb, CanvasText 18%, Canvas); --accent-primary: LinkText; --status-error-surface: Mark; --status-error-text: MarkText; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--surface-primary); color: var(--text-primary); font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: var(--space-12) 0; }
    header { display: grid; gap: var(--space-3); margin-bottom: var(--space-8); }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3rem); line-height: 1.05; letter-spacing: -.03em; }
    h2, legend { margin: 0; font-size: 1.25rem; line-height: 1.25; font-weight: 700; }
    p { max-width: 70ch; margin: 0; color: var(--text-secondary); }
    label, .field { display: grid; gap: var(--space-2); font-weight: 700; }
    input, select, textarea { width: 100%; border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-3); background: var(--surface-primary); color: var(--text-primary); font: inherit; }
    input[type="checkbox"] { width: auto; }
    textarea { min-height: 18rem; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: .875rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    input:focus, select:focus, textarea:focus, button:focus { outline: 3px solid var(--accent-primary); outline-offset: 2px; }
    button { border: 1px solid var(--accent-primary); border-radius: 999px; padding: var(--space-3) var(--space-6); background: var(--accent-primary); color: Canvas; font: inherit; font-weight: 700; cursor: pointer; transition: transform 120ms ease-out; }
    button:active { transform: translateY(1px); }
    fieldset { margin: 0; border: 1px solid var(--border-default); border-radius: 1rem; padding: var(--space-6); }
    legend { padding: 0 var(--space-2); }
    .panel { border: 1px solid var(--border-default); border-radius: 1rem; background: var(--surface-panel); padding: var(--space-6); }
    .grid, .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--space-4); }
    .stack, .planner-form { display: grid; gap: var(--space-4); }
    .option-line { display: flex; align-items: center; gap: var(--space-3); font-weight: 700; }
    .error { border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-3); background: var(--status-error-surface); color: var(--status-error-text); font-weight: 700; }
    .caption, .help { font-size: .875rem; color: var(--text-secondary); }
    pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-4); background: var(--surface-subtle); }
  </style>
</head>
<body>${body}</body>
</html>`;
}
