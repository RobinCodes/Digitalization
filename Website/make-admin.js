#!/usr/bin/env node
'use strict';

// Create or update a DevTools admin account.
//   node make-admin.js <username> <password>
// Passwords are never stored in plaintext — only a random salt + scrypt hash.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'admins.json');
const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: node make-admin.js <username> <password>');
  process.exit(1);
}

let admins = [];
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  admins = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.admins) ? raw.admins : []);
} catch { /* file absent or empty — start fresh */ }

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
const rec  = { username, salt, hash };

const i = admins.findIndex(a => a && String(a.username).toLowerCase() === username.toLowerCase());
if (i >= 0) { admins[i] = rec; console.log(`Updated admin "${username}".`); }
else        { admins.push(rec); console.log(`Added admin "${username}".`); }

fs.writeFileSync(FILE, JSON.stringify(admins, null, 2) + '\n', 'utf8');
console.log(`Wrote ${FILE} (${admins.length} admin${admins.length !== 1 ? 's' : ''}).`);