// backend/src/types/express.d.ts
// Express type extensions

import { User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        role: 'PATIENT' | 'DOCTOR' | 'ADMIN';
      };
    }
  }
}

export {};