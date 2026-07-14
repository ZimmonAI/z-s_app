export type ControlPlaneErrorCode =
  | 'managed-app-not-found'
  | 'managed-app-disabled'
  | 'profile-not-found'
  | 'profile-not-active'
  | 'profile-app-mismatch'
  | 'profile-version-ambiguous'
  | 'provider-binding-missing'
  | 'provider-binding-ambiguous'
  | 'provider-not-found'
  | 'provider-disabled'
  | 'prefix-class-not-found'
  | 'prefix-class-ambiguous'
  | 'object-key-outside-prefix'
  | 'capability-not-verified'
  | 'capability-failed'
  | 'capability-expired'
  | 'configuration-conflict';

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;

  constructor(code: ControlPlaneErrorCode) {
    super(code);
    this.name = 'ControlPlaneError';
    this.code = code;
  }
}

export function fail(code: ControlPlaneErrorCode): never {
  throw new ControlPlaneError(code);
}
