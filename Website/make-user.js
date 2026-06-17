#!/usr/bin/env node
'use strict';

// Create or update a site viewer account (can sign in to see member-only notes).
//   node make-user.js <username> <password>
// Passwords are never stored in plaintext — only a random salt + scrypt hash.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'users.json');
const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: node make-user.js <username> <password>');
  process.exit(1);
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
if (!NAME_RE.test(username) || username.length < 3 || username.length > 32) {
  console.error('Username must be 3-32 chars: letters, digits, dot, dash or underscore only.');
  process.exit(1);
}
// Refuse a name that already exists in the other account store (avoids ambiguous logins).
try {
  const _raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'admins.json'), 'utf8'));
  const _list = Array.isArray(_raw) ? _raw : (_raw && Array.isArray(_raw.admins) ? _raw.admins : []);
  if (_list.some(a => a && String(a.username).toLowerCase() === username.toLowerCase())) {
    console.error(`"${username}" already exists as an admin. Pick a different name.`);
    process.exit(1);
  }
} catch { /* no admins.json yet */ }

let users = [];
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  users = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.users) ? raw.users : []);
} catch { /* file absent or empty — start fresh */ }

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
const rec  = { username, salt, hash };

const i = users.findIndex(a => a && String(a.username).toLowerCase() === username.toLowerCase());
if (i >= 0) { users[i] = rec; console.log(`Updated user "${username}".`); }
else        { users.push(rec); console.log(`Added user "${username}".`); }

fs.writeFileSync(FILE, JSON.stringify(users, null, 2) + '\n', 'utf8');
console.log(`Wrote ${FILE} (${users.length} user${users.length !== 1 ? 's' : ''}).`);