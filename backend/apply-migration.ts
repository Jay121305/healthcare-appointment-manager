import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const sql = fs.readFileSync('prisma/migrations/001_add_partial_unique_index/migration.sql', 'utf8');
  const statements = sql.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
  for (const stmt of statements) {
    if (stmt.trim()) {
      await prisma.$queryRawUnsafe(stmt + ';');
      console.log('Executed:', stmt.trim().substring(0, 50) + '...');
    }
  }
  console.log('Migration applied');
  await prisma.$disconnect();
}

main().catch(console.error);