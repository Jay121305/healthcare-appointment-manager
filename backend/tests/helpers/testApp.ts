// tests/helpers/testApp.ts
// Wraps the backend's `createApp()` factory with Supertest for ergonomic
// per-test apps and short-lifecycle cleanup.
//
// We deliberately do NOT start the production server (`bootstrap()` foreman
// in src/index.ts). Supertest binds to an ephemeral in-process socket and
// closes after each test. The 7 BullMQ workers are NOT imported; tests that
// need them start them via the bootWorkers helper.

import express from 'express';
import supertest from 'supertest';
import { createApp } from '../../src/index';
import { prisma } from '../../src/config/prisma';
import { redisClient } from '../../src/config/redis';

let app: express.Express | null = null;

export function getTestApp(): express.Express {
  if (!app) {
    app = createApp();
  }
  return app;
}

export function request(): ReturnType<typeof supertest> {
  return supertest(getTestApp());
}

export async function teardown(): Promise<void> {
  // Disconnect Prisma + Redis between jest workers so the next worker starts fresh.
  await prisma.$disconnect().catch(() => undefined);
  redisClient.disconnect();
  app = null;
}
