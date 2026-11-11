// 单词小勇士 · 标准发音引擎（Kokoro-82M，在后台线程里运行，不卡界面）
// 所有文件都存在浏览器的 Cache 里（wordhero-tts-v1），下载一次以后断网也能用。
const CACHE = 'wordhero-tts-v1';
let BASE = '', MAN = null, TTS = null, PHON = null, cache = null, chain = Promise.resolve();
const post = (m, t) => self.postMessage(m, t || []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getCache() { return cache || (cache = await caches.open(CACHE)); }

// 引擎清单：联网时取最新的，断网时用缓存里的
async function manifest(net) {
  const c = await getCache(), u = BASE + 'manifest.json';
  if (net) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) { const j = await r.clone().json(); if (j && Array.isArray(j.files)) { await c.put(u, r); return j; } }
    } catch (e) {}
  }
  const h = await c.match(u);
  return h ? h.json() : null;
}
async function missing(man) {
  const c = await getCache(), out = [];
  for (const f of man.files) {
    const h = await c.match(BASE + f.name);
    if (!h) { out.push(f); continue; }
    if (f.size) { const n = +(h.headers.get('Content-Length') || 0); if (n && n !== f.size) out.push(f); }
  }
  return out;
}
async function download(list, total, have) {
  const c = await getCache(); let done = have;
  for (const f of list) {
    for (let tries = 1; ; tries++) {
      try {
        const r = await fetch(BASE + f.name, { cache: 'no-store' });
        if (!r.ok) throw new Error('下载失败（' + r.status + '）：' + f.name);
        const rd = r.body.getReader(), chunks = []; let got = 0, last = 0;
        for (;;) {
          const { done: d, value } = await rd.read(); if (d) break;
          chunks.push(value); got += value.length;
          if (got - last > 524288) { last = got; post({ type: 'progress', loaded: done + got, total }); }
        }
        if (f.size && got !== f.size) throw new Error('文件不完整：' + f.name);
        await c.put(BASE + f.name, new Response(new Blob(chunks), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(got) } }));
        done += got; post({ type: 'progress', loaded: done, total });
        break;
      } catch (e) {
        if (tries >= 3) throw e;
        await sleep(1500 * tries);
      }
    }
  }
}
async function blobOf(name, type) {
  const c = await getCache(), r = await c.match(BASE + name);
  if (!r) throw new Error('缺少文件：' + name);
  const b = await r.blob();
  return type ? new Blob([b], { type }) : b;
}
// 模型被切成了几块（网站单个文件不能超过 25MB），这里拼回去
async function modelResponse() {
  const bs = [];
  for (const p of MAN.modelParts) bs.push(await blobOf(p));
  const b = new Blob(bs);
  if (MAN.modelSize && b.size !== MAN.modelSize) throw new Error('模型文件不完整，请删除后重新下载');
  return new Response(b, { headers: { 'Content-Length': String(b.size) } });
}
// 告诉引擎：模型文件都从本地缓存里拿，不要去国外网站下载
function fileFor(key) {
  const k = String(key || '');
  if (/onnx\/model_quantized\.onnx$/.test(k)) return 'MODEL';
  if (/tokenizer_config\.json$/.test(k)) return 'model/tokenizer_config.json';
  if (/tokenizer\.json$/.test(k)) return 'model/tokenizer.json';
  if (/(^|\/)config\.json$/.test(k)) return 'model/config.json';
  return null;
}
const localCache = {
  async match(key) {
    const f = fileFor(key); if (!f) return undefined;
    if (f === 'MODEL') return modelResponse();
    const c = await getCache(), r = await c.match(BASE + f);
    return r || undefined;
  },
  async put() {}
};

async function load() {
  const t0 = Date.now();
  self.WH_TTS_BASE = BASE;
  const lib = URL.createObjectURL(await blobOf(MAN.lib, 'text/javascript'));
  const mod = await import(lib);
  const env = mod.tenv;
  const mjs = URL.createObjectURL(await blobOf(MAN.ortMjs, 'text/javascript'));
  const wasm = URL.createObjectURL(await blobOf(MAN.ortWasm, 'application/wasm'));
  env.backends.onnx.wasm.wasmPaths = { mjs, wasm };
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = BASE;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = localCache;
  TTS = await mod.KokoroTTS.from_pretrained('kokoro', { dtype: 'q8', device: 'wasm' });
  PHON = mod.phonemize || null;
  const t1 = Date.now();
  await TTS.generate('Hello.', { voice: MAN.voices.us, speed: 1 }); // 预热一次，第一个词就不会特别慢
  return { loadMs: t1 - t0, warmMs: Date.now() - t1 };
}

// 去掉首尾的静音，转成 16 位 WAV（体积减半）
function toWav(f32, sr) {
  let a = 0, b = f32.length - 1;
  while (a < b && Math.abs(f32[a]) < 0.008) a++;
  while (b > a && Math.abs(f32[b]) < 0.008) b--;
  a = Math.max(0, a - Math.round(sr * 0.03)); b = Math.min(f32.length - 1, b + Math.round(sr * 0.12));
  const n = Math.max(1, b - a + 1), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let peak = 0; for (let i = a; i <= b; i++) peak = Math.max(peak, Math.abs(f32[i]));
  const g = peak > 0.05 && peak < 0.7 ? 0.85 / peak : 1;
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, f32[a + i] * g)); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return buf;
}

async function init(m) {
  BASE = m.base;
  MAN = await manifest(m.download || m.update);
  if (!MAN) { post({ type: 'nodl' }); return; }
  let miss = await missing(MAN);
  // 引擎小更新（比如只换了几个脚本）：缺的文件不多时自动补下，不用家长再点下载
  const missBytes = miss.reduce((s, f) => s + (f.size || 0), 0);
  if (miss.length && !m.download && !(m.update && miss.length < MAN.files.length && missBytes < 8e6)) { post({ type: 'nodl', partial: miss.length < MAN.files.length }); return; }
  if (miss.length) {
    const total = MAN.files.reduce((s, f) => s + (f.size || 0), 0);
    const have = total - miss.reduce((s, f) => s + (f.size || 0), 0);
    post({ type: 'progress', loaded: have, total });
    await download(miss, total, have);
    miss = await missing(MAN);
    if (miss.length) throw new Error('还有 ' + miss.length + ' 个文件没下载好');
    post({ type: 'downloaded' });
  }
  post({ type: 'loading' });
  const r = await load();
  post({ type: 'ready', ...r, version: MAN.version });
}

self.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'init') {
    chain = chain.then(() => init(m)).catch(err => post({ type: 'error', msg: String(err && err.message || err) }));
  } else if (m.type === 'phon') {
    // 同一个词按美式、英式两套规则转成音标，给家长当候选
    chain = chain.then(async () => {
      if (!PHON) throw new Error('引擎还没准备好');
      const out = {};
      for (const l of ['a', 'b']) { try { out[l] = String(await PHON(m.text, l) || '').trim(); } catch (e) { out[l] = ''; } }
      post({ type: 'phon', id: m.id, out });
    }).catch(err => post({ type: 'phon', id: m.id, err: String(err && err.message || err) }));
  } else if (m.type === 'gen') {
    chain = chain.then(async () => {
      if (!TTS) throw new Error('引擎还没准备好');
      const t0 = Date.now();
      let a;
      if (m.ipa) {
        // 家长校正过的读音：直接按音标读，跳过"英文转音标"这一步
        const { input_ids } = TTS.tokenizer(String(m.ipa), { truncation: true });
        a = await TTS.generate_from_ids(input_ids, { voice: m.voice, speed: m.speed || 1 });
      } else a = await TTS.generate(m.text, { voice: m.voice, speed: m.speed || 1 });
      const wav = toWav(a.audio, a.sampling_rate);
      post({ type: 'audio', id: m.id, wav, ms: Date.now() - t0 }, [wav]);
    }).catch(err => post({ type: 'audio', id: m.id, err: String(err && err.message || err) }));
  }
};
