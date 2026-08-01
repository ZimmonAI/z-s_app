# Z-s Storage Control Design System

## 1. Atmosphere & Identity

Z-s control is a restrained operator console: quiet, exact, and safe-first. The signature is dense trust without clutter: white-space, system colors, and clear form states keep attention on provider/vault authority rather than decoration.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Surface/primary | `--surface-primary` | `Canvas` | Page background |
| Surface/panel | `--surface-panel` | `color-mix(in srgb, CanvasText 4%, Canvas)` | Cards and form panels |
| Surface/subtle | `--surface-subtle` | `color-mix(in srgb, CanvasText 8%, Canvas)` | Secondary blocks |
| Text/primary | `--text-primary` | `CanvasText` | Primary content |
| Text/secondary | `--text-secondary` | `color-mix(in srgb, CanvasText 68%, Canvas)` | Help text and metadata |
| Border/default | `--border-default` | `color-mix(in srgb, CanvasText 18%, Canvas)` | Panel borders |
| Accent/primary | `--accent-primary` | `LinkText` | Primary actions and focus |
| Status/error | `--status-error` | `Mark` | Inline errors |

### Rules
- Use system colors and CSS variables only. No raw hex values in UI source.
- Accent is reserved for interactive elements.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| H1 | `clamp(2rem, 4vw, 3rem)` | 700 | 1.05 | Page title |
| H2 | `1.25rem` | 700 | 1.25 | Card titles |
| Body | `1rem` | 400 | 1.6 | Forms and paragraphs |
| Body/sm | `0.875rem` | 400 | 1.5 | Help text |
| Caption | `0.75rem` | 700 | 1.4 | Labels and metadata |

### Font Stack
- Primary: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Mono: `ui-monospace, "SFMono-Regular", Consolas, monospace`

## 4. Spacing & Layout

### Base Unit
All spacing derives from 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-2` | `0.5rem` | Tight input spacing |
| `--space-3` | `0.75rem` | Form control padding |
| `--space-4` | `1rem` | Standard gaps |
| `--space-6` | `1.5rem` | Panel padding |
| `--space-8` | `2rem` | Major groups |
| `--space-12` | `3rem` | Page padding |

### Grid
- Max content width: `1120px`
- Breakpoints: single-column mobile, two-column summary grid above `760px`

## 5. Components

### Page Shell
- **Structure**: header, main content, optional footer note.
- **States**: authenticated, unauthenticated, not-configured.
- **Accessibility**: one `<main>`, one `<h1>`, clear status text.

### Form Panel
- **Structure**: label above input/textarea, help text below.
- **States**: default, focus, error, disabled.
- **Accessibility**: labels use `for`, focus outline uses `--accent-primary`.

### Planner Fieldset
- **Structure**: `fieldset` and `legend` group vault, route, derivative, and token setup decisions.
- **States**: standard, error, disabled.
- **Accessibility**: use real form controls; each field has a stable label and hint text for secret-reference-only handling.

### Select Control
- **Structure**: native `<select>` for provider type, vault role, retention policy, asset class, derivative target, and output format.
- **States**: default, focus, disabled.
- **Accessibility**: never replace with custom dropdowns; browser keyboard behavior is the default.

### Parameter Input
- **Structure**: text and number inputs for client id, vault id, bucket label, secret reference, delete-after days, and resize widths.
- **States**: default, focus, error.
- **Accessibility**: helper copy explains expected values and secret boundaries.

### Action Button
- **Structure**: native `<button>` with text label.
- **States**: default, hover, active, focus, disabled.
- **Accessibility**: no icon-only actions, visible focus.

## 6. Motion & Interaction

| Type | Duration | Usage |
|------|----------|-------|
| Micro | `120ms` | Button active shift |
| Standard | `200ms` | Border and background transitions |

Only `transform` and color/background transitions are used. Reduced-motion users receive instant state changes.

## 7. Depth & Surface

Strategy: borders-only with tonal shifts. No shadows are required for this operational surface.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA target.
- Browser-native system colors preserve contrast across light/dark modes.
- Forms work without JavaScript.

### Accepted Debt
| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| None | n/a | n/a | n/a |
