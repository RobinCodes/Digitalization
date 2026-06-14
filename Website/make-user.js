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