import mongoose from 'mongoose';
import type { Logger } from './logger.js';

export async function connectDatabase(uri: string, logger: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err: Error) =>
    logger.error({ err }, 'MongoDB connection error'),
  );

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    // Index builds are triggered explicitly via ensureIndexes() at startup.
    autoIndex: false,
  });
  logger.info('Connected to MongoDB');
  return mongoose;
}

export async function ensureIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** Returns true when the database answers a ping within the timeout. */
export async function pingDatabase(timeoutMs = 2_000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) return false;
  try {
    await Promise.race([
      db.admin().command({ ping: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error('ping timeout'));
        }, timeoutMs).unref(),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}
