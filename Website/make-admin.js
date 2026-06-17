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

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
if (!NAME_RE.test(username) || username.length < 3 || username.length > 32) {
  console.error('Username must be 3-32 chars: letters, digits, dot, dash or underscore only.');
  process.exit(1);
}
// Refuse a name that already exists in the other account store (avoids ambiguous logins).
try {
  const _raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
  const _list = Array.isArray(_raw) ? _raw : (_raw && Array.isArray(_raw.users) ? _raw.users : []);
  if (_list.some(a => a && String(a.username).toLowerCase() === username.toLowerCase())) {
    console.error(`"${username}" already exists as a site user. Pick a different name.`);
    process.exit(1);
  }
} catch { /* no users.json yet */ }

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