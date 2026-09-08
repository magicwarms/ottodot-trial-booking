// Worker threads do not inherit the parent's TypeScript loader, so register it
// here before importing the actual (TypeScript) worker body.
import { register } from 'tsx/esm/api';
register();
await import('./seat-worker.ts');
