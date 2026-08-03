'use strict';

const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'public', 'config.js');
const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if ((process.env.GITHUB_ACTIONS || process.env.CF_PAGES) && (!url || !anonKey)) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY.');
  process.exit(1);
}

fs.writeFileSync(out, `window.K12_SUPABASE = ${JSON.stringify({ url, anonKey }, null, 2)};\n`);
console.log(url && anonKey ? 'Supabase config generated.' : 'Supabase config generated with empty values.');
