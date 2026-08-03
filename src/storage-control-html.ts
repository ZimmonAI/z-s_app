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
  <meta name="description" content="Z-s storage control workspace">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --surface-primary: Canvas;
      --surface-panel: color-mix(in srgb, CanvasText 4%, Canvas);
      --surface-subtle: color-mix(in srgb, CanvasText 8%, Canvas);
      --surface-raised: color-mix(in srgb, CanvasText 2%, Canvas);
      --text-primary: CanvasText;
      --text-secondary: color-mix(in srgb, CanvasText 68%, Canvas);
      --border-default: color-mix(in srgb, CanvasText 18%, Canvas);
      --accent-primary: LinkText;
      --accent-contrast: Canvas;
      --status-success-surface: color-mix(in srgb, #16803c 16%, Canvas);
      --status-warning-surface: color-mix(in srgb, #b7791f 18%, Canvas);
      --status-error-surface: color-mix(in srgb, #c53030 18%, Canvas);
      --status-unavailable-surface: color-mix(in srgb, CanvasText 9%, Canvas);
      --space-1: .25rem;
      --space-2: .5rem;
      --space-3: .75rem;
      --space-4: 1rem;
      --space-6: 1.5rem;
      --space-8: 2rem;
      --space-12: 3rem;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface-primary);
      color: var(--text-primary);
      font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(1180px, calc(100% - 2rem)); margin: 0 auto; padding: var(--space-12) 0; }
    header { display: grid; gap: var(--space-3); margin-bottom: var(--space-8); }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3rem); line-height: 1.05; letter-spacing: -.03em; }
    h2, legend { margin: 0; font-size: 1.25rem; line-height: 1.25; font-weight: 700; }
    h3 { margin: 0; font-size: 1rem; }
    p { max-width: 75ch; margin: 0; color: var(--text-secondary); }
    a { color: var(--accent-primary); text-underline-offset: .2em; }
    code { overflow-wrap: anywhere; }
    label, .field { display: grid; gap: var(--space-2); font-weight: 700; }
    input, select, textarea {
      width: 100%;
      min-height: 2.75rem;
      border: 1px solid var(--border-default);
      border-radius: .75rem;
      padding: var(--space-3);
      background: var(--surface-primary);
      color: var(--text-primary);
      font: inherit;
    }
    input[type="checkbox"] { width: auto; min-height: auto; }
    textarea {
      min-height: 18rem;
      font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      font-size: .875rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    :where(input, select, textarea, button, a, [tabindex]):focus-visible {
      outline: 3px solid var(--accent-primary);
      outline-offset: 3px;
    }
    button, .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: fit-content;
      min-height: 2.75rem;
      border: 1px solid var(--accent-primary);
      border-radius: 999px;
      padding: var(--space-2) var(--space-6);
      background: var(--accent-primary);
      color: var(--accent-contrast);
      font: inherit;
      font-weight: 700;
      line-height: 1.2;
      text-decoration: none;
      cursor: pointer;
      transition: transform 120ms ease-out;
    }
    button:active, .button-link:active { transform: translateY(1px); }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .button-secondary {
      background: var(--surface-primary);
      color: var(--accent-primary);
    }
    .button-danger {
      border-color: #b42318;
      background: #b42318;
      color: white;
    }
    fieldset { margin: 0; border: 1px solid var(--border-default); border-radius: 1rem; padding: var(--space-6); }
    legend { padding: 0 var(--space-2); }
    .panel, .subpanel {
      border: 1px solid var(--border-default);
      border-radius: 1rem;
      background: var(--surface-panel);
      padding: var(--space-6);
    }
    .subpanel { background: var(--surface-raised); }
    .grid, .field-grid, .card-grid, .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
      gap: var(--space-4);
    }
    .stack, .planner-form { display: grid; gap: var(--space-4); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
    .section-heading { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
    .option-line { display: flex; align-items: center; gap: var(--space-3); font-weight: 700; }
    .caption, .help, .metric-label { font-size: .875rem; color: var(--text-secondary); }
    .environment-nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-6);
      border-bottom: 1px solid var(--border-default);
      padding-bottom: var(--space-3);
    }
    .environment-nav-label { margin-right: var(--space-2); font-weight: 700; }
    .environment-nav a { border-radius: 999px; padding: var(--space-2) var(--space-4); text-decoration: none; }
    .environment-nav a[aria-current="page"] { background: var(--accent-primary); color: var(--accent-contrast); font-weight: 700; }
    .metric { display: grid; align-content: start; gap: var(--space-2); border: 1px solid var(--border-default); border-radius: 1rem; padding: var(--space-4); background: var(--surface-raised); }
    .metric > strong { font-size: 1.6rem; line-height: 1.1; }
    .badge { display: inline-flex; width: fit-content; border: 1px solid var(--border-default); border-radius: 999px; padding: var(--space-1) var(--space-2); background: var(--surface-subtle); font-size: .78rem; font-weight: 700; line-height: 1.2; text-transform: capitalize; }
    .badge[data-status="valid"], .badge[data-status="active"] { background: var(--status-success-surface); }
    .badge[data-status="invalid"], .badge[data-status="revoked"] { background: var(--status-error-surface); }
    .badge[data-status="expired"], .badge[data-status="unvalidated"], .badge[data-status="draft"] { background: var(--status-warning-surface); }
    .state-message { display: grid; gap: var(--space-2); border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-4); background: var(--surface-subtle); }
    .state-message[data-kind="success"], .state-message[data-kind="success"] { background: var(--status-success-surface); }
    .state-message[data-kind="warning"] { background: var(--status-warning-surface); }
    .state-message[data-kind="error"] { background: var(--status-error-surface); }
    .state-message[data-kind="unavailable"] { background: var(--status-unavailable-surface); }
    .state-message[data-kind="loading"] { animation: pulse 1.2s ease-in-out infinite alternate; }
    .definition-list { display: grid; gap: var(--space-2); margin: 0; }
    .definition-list > div { display: grid; grid-template-columns: minmax(8rem, .35fr) 1fr; gap: var(--space-3); border-bottom: 1px solid var(--border-default); padding: var(--space-2) 0; }
    .definition-list dt { font-weight: 700; }
    .definition-list dd { margin: 0; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--border-default); padding: var(--space-3); text-align: left; vertical-align: top; }
    thead th { font-size: .875rem; color: var(--text-secondary); }
    .target-row { display: grid; grid-template-columns: minmax(8rem, .4fr) minmax(12rem, 1fr) auto; gap: var(--space-3); align-items: end; border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-3); }
    .sticky-actions { position: sticky; bottom: var(--space-3); z-index: 2; border: 1px solid var(--border-default); border-radius: 1rem; padding: var(--space-3); background: color-mix(in srgb, Canvas 92%, transparent); backdrop-filter: blur(8px); }
    dialog { width: min(42rem, calc(100% - 2rem)); border: 1px solid var(--border-default); border-radius: 1rem; padding: var(--space-6); background: var(--surface-primary); color: var(--text-primary); }
    dialog::backdrop { background: rgb(0 0 0 / .55); }
    pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border-default); border-radius: .75rem; padding: var(--space-4); background: var(--surface-subtle); }
    [hidden] { display: none !important; }
    @keyframes pulse { from { opacity: .65; } to { opacity: 1; } }
    @media (max-width: 720px) {
      main { width: min(100% - 1rem, 1180px); padding: var(--space-8) 0; }
      .panel, .subpanel, fieldset { padding: var(--space-4); }
      .target-row { grid-template-columns: 1fr; }
      .definition-list > div { grid-template-columns: 1fr; gap: 0; }
      button, .button-link { width: 100%; }
      .toolbar > .help { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}
