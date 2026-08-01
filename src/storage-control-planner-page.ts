import { controlPage, escapeHtml } from './storage-control-html.js';

interface SelectChoice {
  readonly value: string;
  readonly label: string;
}

interface VaultDefaults {
  readonly vaultId: string;
  readonly driveLabel: string;
  readonly providerType: string;
  readonly bucketLabel: string;
  readonly secretReferenceId: string;
  readonly retentionPolicy: string;
  readonly deleteAfterDays: string;
  readonly role: string;
}

interface RouteDefaults {
  readonly assetClass: string;
  readonly primaryVaultId: string;
  readonly replicaVaultId: string;
  readonly derivativeVaultId: string;
}

const PROVIDER_CHOICES = Object.freeze([
  Object.freeze({ value: 'minio', label: 'MinIO' }),
  Object.freeze({ value: 'r2', label: 'Cloudflare R2' }),
  Object.freeze({ value: 's3-compatible', label: 'S3-compatible' }),
]);
const RETENTION_CHOICES = Object.freeze([
  Object.freeze({ value: 'permanent', label: 'Keep permanent' }),
  Object.freeze({ value: 'hot-cache-short', label: 'Self-delete after days' }),
  Object.freeze({ value: 'custom', label: 'Custom timed retention' }),
]);
const ROLE_CHOICES = Object.freeze([
  Object.freeze({ value: 'canonical', label: 'Canonical vault' }),
  Object.freeze({ value: 'hot', label: 'Hot replica vault' }),
  Object.freeze({ value: 'derivative', label: 'Derivative vault' }),
]);
const ASSET_CHOICES = Object.freeze([
  Object.freeze({ value: 'raw-video', label: 'Raw video' }),
  Object.freeze({ value: 'raw-image', label: 'Raw image' }),
  Object.freeze({ value: 'document', label: 'Document' }),
]);
const FORMAT_CHOICES = Object.freeze([
  Object.freeze({ value: 'webp', label: 'WebP' }),
  Object.freeze({ value: 'avif', label: 'AVIF' }),
  Object.freeze({ value: 'jpeg', label: 'JPEG' }),
  Object.freeze({ value: 'png', label: 'PNG' }),
]);
const VAULT_DEFAULTS = Object.freeze<VaultDefaults[]>([
  Object.freeze({
    vaultId: 'raw-minio-permanent',
    driveLabel: 'Video Maker raw originals',
    providerType: 'minio',
    bucketLabel: 'zs-dev-app-video-maker-canon',
    secretReferenceId: 'credential-binding:minio_zimspace_local_pc_01',
    retentionPolicy: 'permanent',
    deleteAfterDays: '',
    role: 'canonical',
  }),
  Object.freeze({
    vaultId: 'raw-r2-hot-seven-day',
    driveLabel: 'Video Maker hot cache',
    providerType: 'r2',
    bucketLabel: 'video-maker-hot',
    secretReferenceId: 'credential-binding:r2_video_maker_dev_01',
    retentionPolicy: 'hot-cache-short',
    deleteAfterDays: '7',
    role: 'hot',
  }),
  Object.freeze({
    vaultId: 'image-r2-derivatives',
    driveLabel: 'Video Maker resized images',
    providerType: 'r2',
    bucketLabel: 'video-maker-image-derivatives',
    secretReferenceId: 'credential-binding:r2_video_maker_image_derivatives_01',
    retentionPolicy: 'permanent',
    deleteAfterDays: '',
    role: 'derivative',
  }),
]);
const ROUTE_DEFAULTS = Object.freeze<RouteDefaults[]>([
  Object.freeze({ assetClass: 'raw-video', primaryVaultId: 'raw-minio-permanent', replicaVaultId: 'raw-r2-hot-seven-day', derivativeVaultId: '' }),
  Object.freeze({ assetClass: 'raw-image', primaryVaultId: 'raw-minio-permanent', replicaVaultId: 'raw-r2-hot-seven-day', derivativeVaultId: 'image-r2-derivatives' }),
  Object.freeze({ assetClass: 'document', primaryVaultId: 'raw-minio-permanent', replicaVaultId: 'raw-r2-hot-seven-day', derivativeVaultId: '' }),
]);

function choiceOption(choice: Readonly<SelectChoice>, selected: string): string {
  return `<option value="${escapeHtml(choice.value)}"${choice.value === selected ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`;
}

function vaultChoices(selected: string, allowEmpty: boolean): string {
  const empty = allowEmpty ? '<option value="">No extra vault</option>' : '';
  return `${empty}${VAULT_DEFAULTS.map((vault) => choiceOption({ value: vault.vaultId, label: vault.driveLabel }, selected)).join('')}`;
}

function textField(name: string, label: string, value: string, help: string): string {
  const safeName = escapeHtml(name);
  return `<label for="${safeName}">${escapeHtml(label)}<input id="${safeName}" name="${safeName}" value="${escapeHtml(value)}" required><span class="help">${escapeHtml(help)}</span></label>`;
}

function numberField(name: string, label: string, value: string, help: string): string {
  const safeName = escapeHtml(name);
  return `<label for="${safeName}">${escapeHtml(label)}<input id="${safeName}" name="${safeName}" type="number" min="1" max="36500" value="${escapeHtml(value)}"><span class="help">${escapeHtml(help)}</span></label>`;
}

function selectField(name: string, label: string, choices: readonly SelectChoice[], selected: string, help: string): string {
  const safeName = escapeHtml(name);
  return `<label for="${safeName}">${escapeHtml(label)}<select id="${safeName}" name="${safeName}">${choices.map((choice) => choiceOption(choice, selected)).join('')}</select><span class="help">${escapeHtml(help)}</span></label>`;
}

function vaultSelectField(name: string, label: string, selected: string, allowEmpty: boolean, help: string): string {
  const safeName = escapeHtml(name);
  return `<label for="${safeName}">${escapeHtml(label)}<select id="${safeName}" name="${safeName}">${vaultChoices(selected, allowEmpty)}</select><span class="help">${escapeHtml(help)}</span></label>`;
}

function vaultFieldset(vault: Readonly<VaultDefaults>, index: number): string {
  const prefix = `vault${index}`;
  return `<fieldset class="stack"><legend>${escapeHtml(vault.driveLabel)}</legend><div class="field-grid">
      ${textField(`${prefix}VaultId`, 'Vault id', vault.vaultId, 'Stable storage-control id used by route rules.')}
      ${textField(`${prefix}DriveLabel`, 'Human name', vault.driveLabel, 'Operator-facing name for this drive or vault.')}
      ${selectField(`${prefix}ProviderType`, 'Provider type', PROVIDER_CHOICES, vault.providerType, 'Choose MinIO, R2, or S3-compatible storage.')}
      ${selectField(`${prefix}Role`, 'Vault role', ROLE_CHOICES, vault.role, 'Canonical stores truth, hot stores temporary replicas, derivative stores generated objects.')}
      ${textField(`${prefix}BucketLabel`, 'Bucket label', vault.bucketLabel, 'Non-secret bucket identity or label.')}
      ${textField(`${prefix}SecretReferenceId`, 'Secret reference', vault.secretReferenceId, 'Reference to env/secret binding only. Do not paste raw provider secrets here.')}
      ${selectField(`${prefix}RetentionPolicy`, 'Retention', RETENTION_CHOICES, vault.retentionPolicy, 'Permanent keeps objects; timed policies require days below.')}
      ${numberField(`${prefix}DeleteAfterDays`, 'Delete after days', vault.deleteAfterDays, 'Use 7 for Video Maker hot R2; leave blank for permanent vaults.')}
    </div></fieldset>`;
}

function routeFieldset(route: Readonly<RouteDefaults>, index: number): string {
  const prefix = `route${index}`;
  return `<fieldset class="stack"><legend>Asset route ${index + 1}</legend><div class="field-grid">
      ${selectField(`${prefix}AssetClass`, 'Asset class', ASSET_CHOICES, route.assetClass, 'Only raw image routes may choose a derivative vault.')}
      ${vaultSelectField(`${prefix}PrimaryVaultId`, 'Primary vault', route.primaryVaultId, false, 'Where this asset class is first written.')}
      ${vaultSelectField(`${prefix}ReplicaVaultId`, 'Replica vault', route.replicaVaultId, true, 'Optional second vault for clone or hot delivery.')}
      ${vaultSelectField(`${prefix}DerivativeVaultId`, 'Image derivative vault', route.derivativeVaultId, true, 'Only use for raw-image resize outputs.')}
    </div></fieldset>`;
}

function derivativeFieldset(): string {
  return `<fieldset class="stack"><legend>Image resize rule</legend>
    <label class="option-line"><input name="enableImageDerivative" type="checkbox" value="on" checked>Enable image resize derivative</label>
    <div class="field-grid">
      ${textField('derivative0DerivativeId', 'Derivative rule id', 'image-web-resize', 'Stable id for this resize rule.')}
      ${vaultSelectField('derivative0SourceVaultId', 'Source vault', 'raw-minio-permanent', false, 'Raw image source vault.')}
      ${vaultSelectField('derivative0TargetVaultId', 'Target vault', 'image-r2-derivatives', false, 'Explicit vault for generated resized image objects.')}
      ${textField('derivative0Widths', 'Resize widths', '512,1024,1600', 'Comma-separated widths in pixels.')}
      ${selectField('derivative0Format', 'Output format', FORMAT_CHOICES, 'webp', 'Generated image format.')}
    </div></fieldset>`;
}

export function storagePlannerPage(error?: string): string {
  const errorBlock = error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  return controlPage('Storage vault planner', `<main>
  <header>
    <p class="caption">Authenticated Z-s control</p>
    <h1>Storage vault planner</h1>
    <p>Set client vaults, provider secret references, retention, asset routes, hot clones, and image-only resize outputs without exposing raw provider credentials.</p>
  </header>
  <section class="grid" aria-label="Plan coverage">
    <div class="panel"><h2>Vaults and drives</h2><p>Name each storage space, choose MinIO/R2/S3-compatible, and bind it by secret reference only.</p></div>
    <div class="panel"><h2>Retention routing</h2><p>Keep canonical originals permanently, or set timed deletion windows for hot/cache vaults.</p></div>
    <div class="panel"><h2>Image derivatives</h2><p>Resize only image uploads and write generated objects to an explicit derivative vault.</p></div>
  </section>
  <form class="planner-form" method="post" action="/admin/storage/plans">
    ${errorBlock}
    <fieldset class="stack"><legend>Client setup</legend><div class="field-grid">
        ${textField('clientId', 'Client app id', 'video-maker_app', 'The client app that will use this storage setup.')}
        ${textField('tokenPurpose', 'Client token purpose', 'storage-runtime-client', 'Stored as digest-only token intent; raw token values are not rendered.')}
      </div></fieldset>
    ${VAULT_DEFAULTS.map((vault, index) => vaultFieldset(vault, index)).join('')}
    ${ROUTE_DEFAULTS.map((route, index) => routeFieldset(route, index)).join('')}
    ${derivativeFieldset()}
    <button type="submit">Preview safe plan</button>
  </form>
</main>`);
}
