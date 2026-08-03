'use strict';

const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'public', 'config.js');
const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

fs.writeFileSync(out, `window.K12_SUPABASE = ${JSON.stringify({ url, anonKey }, null, 2)};\n`);
console.log(url && anonKey ? 'Supabase config generated.' : 'Supabase config generated with empty values.');
