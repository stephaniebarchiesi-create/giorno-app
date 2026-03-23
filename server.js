import express from 'express';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import pg from 'pg';
import * as oidcClient from 'openid-client';
import memoize from 'memoizee';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const PgSession = connectPgSimple(session);
const PORT = process.env.PORT || 5000;
const DATA_FILE = join(__dirname, 'shortcut-data.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid VARCHAR PRIMARY KEY,
        sess JSONB NOT NULL,
        expire TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS IDX_session_expire ON sessions (expire);

      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY,
        email VARCHAR UNIQUE,
        first_name VARCHAR,
        last_name VARCHAR,
        profile_image_url VARCHAR,
        is_paid BOOLEAN DEFAULT FALSE,
        is_owner BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_data (
        user_id VARCHAR NOT NULL,
        key VARCHAR NOT NULL,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_
