// backend/src/index.ts
// Express server entry point

import express from 'express';
import cors from 'cors';
import { env, validateEnv } from './config/env';
import { prisma } from './config/prisma';
import authRoutes from './routes/auth';
import adminRouter from './routes/admin/doctors';
import bookingRouter from './routes/booking/index';
import visitsRouter from './routes/visits';
import calendarRouter from './routes/calendar';

// Validate environment variables
validateEnv();

export function createApp(): express.Express {
  const app = express();

  // Middleware
  app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }));
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/auth', authRoutes);
  app.use('/admin', adminRouter);
  app.use('/bookings', bookingRouter);
  app.use('/visits', visitsRouter);
  app.use('/calendar', calendarRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}

async function bootstrap(): Promise<void> {
  // Side-effect: import workers (start BullMQ consumers). Tests should NOT
  // reach this path — they import `createApp` directly without workers.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  await import('./config/redis');
  await Promise.all([
    import('./workers/emailWorker'),
    import('./workers/preVisitWorker'),
    import('./workers/postVisitWorker'),
    import('./workers/medicationReminderWorker'),
    import('./workers/reminderScanWorker'),
    import('./workers/medicationExpansionWorker'),
    import('./workers/calendarSyncWorker'),
  ]);

  const app = createApp();
  const PORT = env.port;

  app.listen(PORT, async () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📍 Environment: ${env.nodeEnv}`);

    try {
      await prisma.$connect();
      console.log('✅ Database connected');
    } catch (err) {
      console.error('❌ Database connection failed:', err);
      process.exit(1);
    }
  });
}

// Run only when invoked directly (e.g., `tsx watch src/index.ts`), NOT when imported
// from the test harness.
if (require.main === module) {
  void bootstrap();
}
