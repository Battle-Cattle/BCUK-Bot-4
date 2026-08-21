// Temporary barrel: `shared.ts` used to hold every function below directly. It's been split
// by responsibility into `validation.ts`/`viewHelpers.ts`/`errorHandling.ts`/`uploadMiddleware.ts`;
// this re-export keeps every existing importer working while they're migrated to import from
// the new files directly, in a follow-up PR that deletes this barrel.
export * from './validation';
export * from './viewHelpers';
export * from './errorHandling';
export * from './uploadMiddleware';
