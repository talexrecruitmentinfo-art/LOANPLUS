import type { Request } from 'express';
import type { AuthPrincipal } from './security.util';

export type AuthenticatedRequest = Request & { principal?: AuthPrincipal };