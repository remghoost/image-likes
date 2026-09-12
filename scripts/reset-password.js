/**
 * Manually reset a user's password.
 *
 * Image Likes has no email, so there is no "send a reset link" flow. Instead,
 * the owner runs this script on the host machine to set a new password for a
 * user — either a specific one, or a random one to share out-of-band (text,
 * DM, in person, etc.).
 *
 * Usage:
 *   node scripts/reset-password.js <username> [newpassword]
 *   node scripts/reset-password.js --list
 *
 *   <username>     the account to reset (case-insensitive)
 *   [newpassword]  optional; if omitted, a random password is generated and
 *                  printed so you can share it with the user
 *   --list         list all usernames and exit
 *
 * Notes:
 *   - Passwords are hashed with scrypt (same scheme as the app:
 *     "scrypt:<salt hex>:<hash hex>").
 *   - Resetting a password logs out all of that user's existing sessions, so
 *     no stale session keeps working after the reset.
 *   - The new password must be at least 6 characters (the app's minimum).
 *   - Safe to run while the server is up (SQLite WAL allows a second writer).
 */
const crypto = require('crypto');
const db = require('../db');

// --- Password hashing (mirrors server.js exactly) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function usage() {
  console.log('Usage:');
  console.log('  node scripts/reset-password.js <username> [newpassword]');
  console.log('  node scripts/reset-password.js --list');
  console.log('');
  console.log('  <username>     account to reset (case-insensitive)');
  console.log('  [newpassword]  optional; omit to generate a random one');
  console.log('  --list         list all usernames');
}

const args = process.argv.slice(2);

// --- --list: show all usernames and exit ---
if (args[0] === '--list') {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
  if (!users.length) {
    console.log('No users found.');
  } else {
    console.log(`Users (${users.length}):`);
    for (const u of users) {
      console.log(`  ${u.username}  (id=${u.id}, created ${u.created_at})`);
    }
  }
  db.close();
  process.exit(0);
}

// --- Parse <username> [newpassword] ---
const username = (args[0] || '').trim();
const newPassword = args[1];

if (!username) {
  console.error('Error: no username given.');
  console.error('');
  usage();
  db.close();
  process.exit(1);
}

// Look up the user (case-insensitive, matching the app's COLLATE NOCASE).
const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`Error: no user named "${username}".`);
  console.error('Run with --list to see all usernames.');
  db.close();
  process.exit(1);
}

// Determine the new password: use the one given, or generate a random one.
let finalPassword = newPassword;
let generated = false;
if (finalPassword === undefined || finalPassword === null || finalPassword === '') {
  finalPassword = crypto.randomBytes(12).toString('base64url');
  generated = true;
}

if (typeof finalPassword !== 'string' || finalPassword.length < 6) {
  console.error('Error: new password must be at least 6 characters.');
  db.close();
  process.exit(1);
}

// Reset the password and log out all existing sessions for this user.
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(finalPassword), user.id);
const deleted = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

console.log(`Password reset for "${user.username}".`);
if (generated) {
  console.log(`  New (generated) password: ${finalPassword}`);
  console.log('  Share this with the user, then have them log in and change it.');
} else {
  console.log('  (password set to the value you provided)');
}
if (deleted.changes > 0) {
  console.log(`  Logged out ${deleted.changes} existing session(s).`);
}
console.log('Done.');

db.close();
process.exit(0);
