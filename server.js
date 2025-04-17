// server.js
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';

const app = express();

const PORT           = process.env.PORT || 210;
const DATA_PATH      = process.env.DATA_PATH || path.resolve('./dataset.jsonl');
const MAX_BODY_SIZE  = '1mb';
const MAX_SOURCE_LEN = parseInt(process.env.MAX_SOURCE_LEN) || 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 60;       
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS)   || 24 * 60 * 60 * 1000;
const CACHE_MAX      = parseInt(process.env.CACHE_MAX)      || 50000;

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(morgan('combined'));

const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/dataset', postLimiter);

const writeStream = fs.createWriteStream(DATA_PATH, { flags: 'a' });
const seen = new LRUCache({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS
});

let totalCount   = 0;
let savedCount   = 0;
let skippedCount = 0;


app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/metrics', (req, res) => {
  res.json({
    total:   totalCount,
    saved:   savedCount,
    skipped: skippedCount,
    uptime:  process.uptime()
  });
});

app.post('/api/dataset', (req, res) => {
  totalCount++;

  let { source_text, translated_text, timestamp, language, model } = req.body;
  if (typeof source_text !== 'string' || !source_text.trim()) {
    return res.status(400).json({ error: 'Invalid source_text' });
  }
  source_text = source_text.trim().slice(0, MAX_SOURCE_LEN);

  const key = `${model || 'unknown'}::${source_text}`;
  if (seen.has(key)) {
    skippedCount++;
    console.log('⚠️ Duplicate skipped:', source_text);
    return res.status(200).json({ skipped: true });
  }
  seen.set(key, true);

  const entry = {
    source_text,
    translated_text: translated_text?.toString().slice(0, 2000) || '',
    timestamp:       timestamp || new Date().toISOString(),
    language:        language || '',
    model:           model || ''
  };

  writeStream.write(JSON.stringify(entry) + '\n', err => {
    if (err) {
      console.error('❌ WriteError:', err);
      return res.status(500).json({ error: 'WriteError' });
    }
    savedCount++;
    console.log('✅ Saved:', source_text);
    res.json({ ok: true });
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('🚨 UncaughtError:', err);
  res.status(500).json({ error: 'ServerError' });
});

const shutdown = () => {
  console.log('🛑 Shutting down, closing writeStream...');
  writeStream.end(() => {
    console.log('✅ Stream closed. Bye!');
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`🚀 Dataset API listening on http://0.0.0.0:${PORT}`);
});
